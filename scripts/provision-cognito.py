#!/usr/bin/env python3
"""Provision only this challenge's Cognito resources through the AWS CLI.

Partial progress is saved after each mutation. Re-running resumes that state.
Passwords go through mode-0600 input files, never command arguments or stdout.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local'
LOCAL.mkdir(mode=0o700, exist_ok=True)
STATE = LOCAL / 'cognito.json'
AUDIENCE = 'https://secure-entry.example/api'


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as target:
        target.write(value)


def aws(service, action, payload=None, region=None):
    command = ['aws', service, action, '--output', 'json', '--no-cli-pager']
    if region:
        command += ['--region', region]
    with tempfile.NamedTemporaryFile(mode='w', dir=LOCAL) as data:
        if payload is not None:
            json.dump(payload, data)
            data.flush()
            command += ['--cli-input-json', 'file://' + data.name]
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if result.stdout.strip() else {}


def main():
    identity = aws('sts', 'get-caller-identity')
    region = os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or subprocess.check_output(['aws', 'configure', 'get', 'region'], text=True).strip()
    state = json.loads(STATE.read_text()) if STATE.exists() else {'account': identity['Account'], 'region': region}
    if state['account'] != identity['Account'] or state['region'] != region:
        raise RuntimeError('Existing local Cognito state belongs to another AWS account or region')
    if (ROOT / '.env').exists() and not STATE.exists():
        raise RuntimeError('An existing .env has no matching provisioning state; preserve it before provisioning')

    def save():
        private_write(STATE, json.dumps(state, indent=2) + '\n')

    def call(action, payload):
        return aws('cognito-idp', action, payload, region)

    if 'poolId' not in state:
        pool = call('create-user-pool', {
            'PoolName': 'secure-entry-challenge',
            'UserPoolTier': 'ESSENTIALS',
            'AdminCreateUserConfig': {'AllowAdminCreateUserOnly': True},
            'Policies': {'PasswordPolicy': {'MinimumLength': 16, 'RequireUppercase': True, 'RequireLowercase': True, 'RequireNumbers': True, 'RequireSymbols': True}},
            'MfaConfiguration': 'OFF',
            'UserPoolTags': {'Project': 'secure-entry-challenge'},
        })['UserPool']
        state['poolId'] = pool['Id']
        save()
    pool_id = state['poolId']
    if not state.get('resourceServer'):
        call('create-resource-server', {'UserPoolId': pool_id, 'Identifier': AUDIENCE, 'Name': 'Secure Entry API', 'Scopes': [{'ScopeName': 'users', 'ScopeDescription': 'Manage the challenge user list'}]})
        state['resourceServer'] = True
        save()
    if 'clientId' not in state:
        client = call('create-user-pool-client', {
            'UserPoolId': pool_id, 'ClientName': 'secure-entry-local-pkce', 'GenerateSecret': False,
            'AllowedOAuthFlowsUserPoolClient': True, 'AllowedOAuthFlows': ['code'],
            'AllowedOAuthScopes': ['openid', AUDIENCE + '/users'],
            'CallbackURLs': ['http://localhost:8085/callback'],
            'SupportedIdentityProviders': ['COGNITO'],
            'ExplicitAuthFlows': ['ALLOW_REFRESH_TOKEN_AUTH'],
            'PreventUserExistenceErrors': 'ENABLED',
            'EnableTokenRevocation': True,
            'AccessTokenValidity': 15, 'IdTokenValidity': 15, 'RefreshTokenValidity': 1,
            'TokenValidityUnits': {'AccessToken': 'minutes', 'IdToken': 'minutes', 'RefreshToken': 'days'},
        })['UserPoolClient']
        state['clientId'] = client['ClientId']
        save()
    if 'domain' not in state:
        domain = 'secure-entry-' + pool_id.lower().replace('_', '-')
        call('create-user-pool-domain', {'UserPoolId': pool_id, 'Domain': domain, 'ManagedLoginVersion': 2})
        state['domain'] = domain
        save()
    if not state.get('branding'):
        call('create-managed-login-branding', {'UserPoolId': pool_id, 'ClientId': state['clientId'], 'UseCognitoProvidedValues': True})
        state['branding'] = True
        save()
    if 'username' not in state:
        call('admin-create-user', {'UserPoolId': pool_id, 'Username': 'challenge-reviewer', 'MessageAction': 'SUPPRESS'})
        state['username'] = 'challenge-reviewer'
        save()
    password_file = LOCAL / 'test-user-password'
    if not password_file.exists():
        private_write(password_file, secrets.token_urlsafe(24) + 'aA1!')
    if not state.get('passwordSet'):
        call('admin-set-user-password', {'UserPoolId': pool_id, 'Username': state['username'], 'Password': password_file.read_text(), 'Permanent': True})
        state['passwordSet'] = True
        save()
    issuer = f'https://cognito-idp.{region}.amazonaws.com/{pool_id}'
    private_write(ROOT / '.env', '\n'.join([
        f'OIDC_ISSUER={issuer}', f'OIDC_JWKS_URI={issuer}/.well-known/jwks.json',
        f'OIDC_AUDIENCE={AUDIENCE}', f'OIDC_CLIENT_ID={state["clientId"]}',
        f'COGNITO_DOMAIN=https://{state["domain"]}.auth.{region}.amazoncognito.com',
        'BACKEND_URL=http://127.0.0.1:3001', 'GATEWAY_HOST=127.0.0.1', 'GATEWAY_PORT=3000',
        'BACKEND_HOST=127.0.0.1', 'BACKEND_PORT=3001', '',
    ]))
    print(f'Cognito ready in {region}: {pool_id}. Test user: {state["username"]}.')
    print('Configuration: .env. Password: .local/test-user-password (private; do not commit).')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        # AWS error responses do not echo the secret input file.
        raise SystemExit(error.stderr.strip()) from None

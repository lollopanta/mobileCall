"""Reject a mismatched/expired development profile before spending time compiling."""
import datetime
import json
import os
from pathlib import Path
import plistlib

temp = Path(os.environ['RUNNER_TEMP'])
with (temp / 'profile.plist').open('rb') as handle:
    profile = plistlib.load(handle)
entitlements = profile['Entitlements']
team = profile['TeamIdentifier'][0]
bundle = os.environ['IOS_BUNDLE_IDENTIFIER']
prefix = profile['ApplicationIdentifierPrefix'][0]
if entitlements.get('application-identifier') != f'{prefix}.{bundle}':
    raise ValueError('Provisioning profile must match IOS_BUNDLE_IDENTIFIER exactly')
if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
    raise ValueError('Provisioning profile has expired')
if entitlements.get('get-task-allow') or profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices'):
    raise ValueError('Use an App Store Connect distribution profile, not development, ad hoc, or enterprise')
if entitlements.get('beta-reports-active') is not True:
    raise ValueError('Provisioning profile is not enabled for TestFlight distribution')
metadata = {'team': team, 'uuid': profile['UUID']}
(temp / 'signing.json').write_text(json.dumps(metadata))
with (temp / 'ExportOptions.plist').open('wb') as handle:
    plistlib.dump({
        'method': 'app-store-connect',
        'destination': 'export',
        'teamID': team,
        'signingStyle': 'manual',
        'signingCertificate': 'Apple Distribution',
        'provisioningProfiles': {bundle: profile['UUID']},
        'manageAppVersionAndBuildNumber': False,
        'uploadSymbols': True,
    }, handle)

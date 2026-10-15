"""Regression checks using an isolated database: python -m unittest discover -s tests."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["SECRET_KEY"] = "audit-test-secret-" + "x" * 32
import setupDB
from api.services.fall_sensor import FallSensorService

with patch.object(FallSensorService, '__init__', return_value=None):
    from api import app as api
from fastapi import HTTPException
from starlette.requests import Request


def request(payload=None, cookies=''):
    async def receive():
        return {'type': 'http.request', 'body': json.dumps(payload).encode(), 'more_body': False}
    return Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': [(b'cookie', cookies.encode())]}, receive)


class AuditTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(setupDB, '_DB_PATH', str(Path(self.temp.name) / 'test.db'))
        self.db_patch.start()
        setupDB.init_db()
        setupDB.add_new_user('member', 'test-password')
        self.user = setupDB.get_user('member')
        api.connected_users.clear()
        api.call_sessions.clear()

    def tearDown(self):
        api.connected_users.clear()
        api.call_sessions.clear()
        self.db_patch.stop()
        self.temp.cleanup()

    async def test_profile_excludes_password(self):
        result = await api.get_profile(self.user)
        self.assertNotIn('password', result['user'])
        self.assertEqual(result['user']['username'], 'member')

    async def test_forged_display_cookie_cannot_read_profile(self):
        result = await api.user_profile_view(request(cookies='logged_in_user=member'), 'member')
        self.assertEqual(result.status_code, 303)

    async def test_invalid_credentials_return_400(self):
        for payload in ({}, {'username': [], 'password': 'x'}, {'username': 'member', 'password': 'è' * 37}):
            for handler in (api.login, api.register):
                result = await handler(request(payload))
                self.assertEqual(result.status_code, 400)

    async def test_membership_and_invitation_cannot_be_replayed(self):
        conn = setupDB.get_connection()
        conn.execute('INSERT INTO invitations (family_id, sender_id, receiver_id) VALUES (1, 1, ?)', (self.user['id'],))
        invite_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
        conn.commit()
        conn.close()
        payload = {'invite_id': invite_id, 'response': 'accepted', 'role': 'caregiver'}
        result = await api.respond_notification(request(payload), self.user)
        self.assertEqual(result['status'], 'successful')
        result = await api.respond_notification(request(payload), self.user)
        self.assertEqual(result.status_code, 404)
        with self.assertRaises(HTTPException) as raised:
            await api.create_family(request({'name': 'Replacement'}), self.user)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(setupDB.get_user('member')['family_id'], 1)

    async def test_crop_rejects_traversal_and_other_users_images(self):
        for image_id in ('../../secret.jpg', 'user_999_group_photo.jpg'):
            with self.assertRaises(HTTPException) as raised:
                await api.finalize_crop(request({'image_id': image_id, 'face': {'x': 0, 'y': 0, 'w': 10, 'h': 10}}), self.user)
            self.assertEqual(raised.exception.status_code, 403)

    async def test_signaling_requires_authenticated_family_and_session(self):
        api.connected_users.update({'a': {'family_id': 1}, 'b': {'family_id': 2}, 'c': {'family_id': 1}})
        with patch.object(api.sio, 'emit', new_callable=AsyncMock) as emit:
            for handler in (api.handle_offer, api.handle_answer, api.handle_ice_candidate, api.handle_call_rejected, api.handle_end_call):
                for sid, target in (('unknown', 'a'), ('a', 'b'), ('a', None)):
                    await handler(sid, {'to': target})
            emit.assert_not_awaited()
            await api.handle_ice_candidate('a', {'to': 'c', 'candidate': {}})
            emit.assert_awaited_once()
        api.call_sessions['session'] = {'caller_sid': 'a', 'controller_sid': 'c'}
        with patch.object(api.sio, 'emit', new_callable=AsyncMock) as emit:
            await api.handle_end_call('b', {'sessionId': 'session'})
            self.assertIn('session', api.call_sessions)
            emit.assert_not_awaited()
            await api.handle_end_call('c', {'sessionId': 'session'})
            self.assertNotIn('session', api.call_sessions)
            emit.assert_awaited_once()

    async def test_json_requires_object(self):
        for payload in ([], None, "text"):
            with self.assertRaises(HTTPException) as raised:
                await api.login(request(payload))
            self.assertEqual(raised.exception.status_code, 400)

    def test_album_url_rejects_internal_and_untrusted_hosts(self):
        for url in ('http://127.0.0.1/', 'file:///etc/passwd', 'https://photos.google.com.evil.test/', 'https://photos.google.com:8443/'):
            with self.assertRaises(HTTPException):
                api.validate_album_url(url)
        self.assertEqual(api.validate_album_url('https://photos.app.goo.gl/example'), 'https://photos.app.goo.gl/example')

    def test_pairing_expires_and_cannot_swap_devices_twice(self):
        import datetime
        past = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(minutes=1)).isoformat()
        future = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(minutes=10)).isoformat()
        setupDB.start_device_pairing(1, self.user['id'], 'screen', 'ABC123', past)
        pairing = setupDB.get_device_pairing_for_user(1, self.user['id'])
        self.assertFalse(setupDB.complete_device_pairing(pairing['id'], 'phone'))
        setupDB.start_device_pairing(1, self.user['id'], 'screen', 'ABC123', future)
        pairing = setupDB.get_device_pairing_for_user(1, self.user['id'])
        self.assertTrue(setupDB.complete_device_pairing(pairing['id'], 'phone'))
        self.assertFalse(setupDB.complete_device_pairing(pairing['id'], 'screen'))
        self.assertEqual(setupDB.get_device_role_for_device(1, self.user['id'], 'screen')['device_role'], 'viewer')

    async def test_image_upload_validates_content_and_size(self):
        from io import BytesIO
        from PIL import Image
        from starlette.datastructures import UploadFile
        with self.assertRaises(HTTPException) as raised:
            await api.read_validated_image(UploadFile(filename='fake.jpg', file=BytesIO(b'<html>invalid</html>')))
        self.assertEqual(raised.exception.status_code, 400)
        with patch.object(api, 'MAX_UPLOAD_BYTES', 8):
            with self.assertRaises(HTTPException) as raised:
                await api.read_validated_image(UploadFile(filename='large.jpg', file=BytesIO(b'0' * 9)))
            self.assertEqual(raised.exception.status_code, 413)
        content = BytesIO()
        Image.new('RGB', (2, 2)).save(content, format='PNG')
        result = await api.read_validated_image(UploadFile(filename='valid.png', file=BytesIO(content.getvalue())))
        self.assertEqual(result, content.getvalue())

    async def test_sensor_task_is_cancelled_and_bus_closed_on_shutdown(self):
        from unittest.mock import Mock
        sensor = Mock()
        started = asyncio.Event()
        async def monitor(*args):
            started.set()
            await asyncio.Future()
        sensor.start_monitoring.side_effect = monitor
        with patch.object(api, 'FallSensorService', return_value=sensor):
            async with api.lifespan(api.app):
                await started.wait()
            sensor.bus.close.assert_called_once()

    def test_http_auth_and_validation_flow(self):
        from fastapi.testclient import TestClient
        client = TestClient(api.app, base_url="https://testserver")
        self.assertEqual(client.post('/login', json=[]).status_code, 400)
        self.assertEqual(client.post('/login', content='{').status_code, 400)
        self.assertEqual(client.get('/api/profile').status_code, 401)
        login = client.post('/login', json={'username': 'member', 'password': 'test-password'})
        self.assertEqual(login.status_code, 200)
        profile = client.get('/api/profile')
        self.assertEqual(profile.status_code, 200)
        self.assertNotIn('password', profile.json()['user'])
        self.assertEqual(client.get('/user/member').status_code, 200)
        self.assertEqual(client.post('/api/profile/upload-direct', files={'image': ('fake.jpg', b'not an image', 'image/jpeg')}).status_code, 400)

    def test_sensor_decodes_minimum_signed_value(self):
        sensor = FallSensorService.__new__(FallSensorService)
        from unittest.mock import Mock
        sensor.bus = Mock()
        sensor.address = 0x68
        sensor.bus.read_byte_data.side_effect = [0x80, 0x00]
        self.assertEqual(sensor.read_raw_data(0x3B), -32768)


if __name__ == '__main__':
    unittest.main()

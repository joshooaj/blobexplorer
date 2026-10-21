"""Tests for scripts/fetch_blobs.py against a local fixture server.

No network or Azure account needed: a stdlib HTTP server replays Azure
`comp=list` XML, including NextMarker paging and gzip encoding.

Run: python3 -m unittest discover -s tests
"""

import contextlib
import gzip
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import fetch_blobs  # noqa: E402

PAGE1 = """<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults ServiceEndpoint="http://example.invalid" ContainerName="cont">
  <Blobs>
    <Blob>
      <Name>docs/read me.txt</Name>
      <Properties>
        <Content-Length>12</Content-Length>
        <Last-Modified>Mon, 01 Jan 2024 00:00:00 GMT</Last-Modified>
        <Content-Type>text/plain</Content-Type>
      </Properties>
    </Blob>
    <Blob>
      <Name>\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.zip</Name>
      <Properties>
        <Content-Length>7</Content-Length>
        <Last-Modified>Tue, 02 Jan 2024 00:00:00 GMT</Last-Modified>
        <Content-Type>application/zip</Content-Type>
      </Properties>
    </Blob>
    <Blob>
      <Name>no-properties</Name>
    </Blob>
  </Blobs>
  <NextMarker>mark er 1</NextMarker>
</EnumerationResults>
"""

PAGE2 = """<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults ServiceEndpoint="http://example.invalid" ContainerName="cont">
  <Blobs>
    <Blob>
      <Name>second/final.exe</Name>
      <Properties>
        <Content-Length>1</Content-Length>
        <Last-Modified>Wed, 03 Jan 2024 00:00:00 GMT</Last-Modified>
        <Content-Type>application/x-msdownload</Content-Type>
      </Properties>
    </Blob>
  </Blobs>
</EnumerationResults>
"""


class FixtureHandler(BaseHTTPRequestHandler):
    requests = []  # request-target of each GET

    def do_GET(self):
        FixtureHandler.requests.append(self.path)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        if 'marker' in query:
            assert query['marker'] == ['mark er 1'], query['marker']
            body = PAGE2.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/xml')
            self.end_headers()
            self.wfile.write(body)
        else:
            body = gzip.compress(PAGE1.encode('utf-8'))
            self.send_response(200)
            self.send_header('Content-Type', 'text/xml')
            self.send_header('Content-Encoding', 'gzip')
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):
        pass  # silence stderr request logging


class FetchBlobsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        FixtureHandler.requests = []
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        cls.thread = __import__('threading').Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        port = cls.server.server_address[1]
        cls.base_url = f'http://127.0.0.1:{port}/cont'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FixtureHandler.requests = []

    def fetch_all(self, download_base):
        with contextlib.redirect_stdout(io.StringIO()):  # silence fetch logging
            return fetch_blobs.fetch_all_blobs(self.base_url, download_base)

    def test_paging_and_parsing(self):
        blobs = self.fetch_all(self.base_url)
        self.assertEqual([b['Name'] for b in blobs],
                         ['docs/read me.txt', '\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.zip',
                          'no-properties', 'second/final.exe'])
        self.assertEqual(len(FixtureHandler.requests), 2)
        second = urllib.parse.urlsplit(FixtureHandler.requests[1])
        self.assertEqual(urllib.parse.parse_qs(second.query)['marker'], ['mark er 1'])

    def test_blob_fields_and_url_encoding(self):
        blobs = {b['Name']: b for b in self.fetch_all(self.base_url)}
        doc = blobs['docs/read me.txt']
        self.assertEqual(doc['Url'], f'{self.base_url}/docs/read%20me.txt')
        self.assertEqual(doc['Length'], 12)
        self.assertEqual(doc['LastModified'], 'Mon, 01 Jan 2024 00:00:00 GMT')
        self.assertEqual(doc['ContentType'], 'text/plain')
        self.assertEqual(blobs['\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.zip']['Url'],
                         f'{self.base_url}/%E6%97%A5%E6%9C%AC%E8%AA%9E/%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.zip')
        bare = blobs['no-properties']
        self.assertEqual((bare['Length'], bare['LastModified'], bare['ContentType']), (0, '', ''))

    def test_download_base_replaces_url_prefix(self):
        blobs = self.fetch_all('https://cdn.example.invalid/cont')
        self.assertTrue(all(b['Url'].startswith('https://cdn.example.invalid/cont/') for b in blobs))

    def test_main_cli_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, 'downloads.json')
            env = dict(os.environ, BASE_URL=self.base_url, DOWNLOAD_BASE='https://cdn.example.invalid/cont')
            result = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(__file__), '..', 'scripts', 'fetch_blobs.py'),
                 '--output', out],
                env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(out) as f:
                blobs = json.load(f)
            self.assertEqual(len(blobs), 4)
            self.assertTrue(blobs[0]['Url'].startswith('https://cdn.example.invalid/cont/'))

    def test_missing_base_url_exits_1(self):
        env = {k: v for k, v in os.environ.items() if k != 'BASE_URL'}
        result = subprocess.run(
            [sys.executable, os.path.join(os.path.dirname(__file__), '..', 'scripts', 'fetch_blobs.py'),
             '--output', os.devnull],
            env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)


if __name__ == '__main__':
    unittest.main()

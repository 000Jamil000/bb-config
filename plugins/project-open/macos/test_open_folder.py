import tempfile
from pathlib import Path, PurePosixPath
import unittest
from urllib.parse import urlencode

from open_folder import mounted_folder, parse_request, within


class FolderRequests(unittest.TestCase):
    def test_exact_path_and_host(self):
        url = 'bb-project-folder://open?' + urlencode({'host': 'host-1', 'path': '/srv/Проект #1', 'request': 'req-1'})
        self.assertEqual(parse_request(url), ('host-1', '/srv/Проект #1', 'req-1'))

    def test_invalid_requests(self):
        for url in ['https://open?host=h&path=/srv&request=r',
                    'bb-project-folder://open?host=h&path=/srv/../secret&request=r',
                    'bb-project-folder://open?host=h&path=/srv&request=r&host=other',
                    'bb-project-folder://open?host=h&path=relative&request=r',
                    'bb-project-folder://open?host=h&path=/srv&request=r&command=anything']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                parse_request(url)

    def test_sftp_root_is_confined(self):
        self.assertEqual(within(PurePosixPath('/srv/projects/app'), PurePosixPath('/srv/projects')), PurePosixPath('app'))
        with self.assertRaises(ValueError):
            within(PurePosixPath('/srv/private'), PurePosixPath('/srv/projects'))

    def test_local_symlinks_cannot_escape_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'projects'; root.mkdir()
            outside = base / 'outside'; outside.mkdir()
            (root / 'link').symlink_to(outside, target_is_directory=True)
            settings = {'hosts': {'local': {'mode': 'local', 'roots': [str(root)]}}}
            self.assertEqual(mounted_folder('local', str(root), settings), root)
            with self.assertRaises(ValueError):
                mounted_folder('local', str(root / 'link'), settings)
            with self.assertRaises(ValueError):
                mounted_folder('unknown', str(root), settings)

    def test_ssh_options_cannot_be_supplied_as_a_profile(self):
        settings = {'hosts': {'server': {'mode': 'sftp', 'root': '/srv/projects', 'sshProfile': '-oProxyCommand=anything'}}}
        with self.assertRaises(ValueError):
            mounted_folder('server', '/srv/projects/app', settings)


if __name__ == '__main__':
    unittest.main()

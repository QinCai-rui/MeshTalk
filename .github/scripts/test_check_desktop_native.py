import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check-desktop-native.sh")


class CheckDesktopNativeTest(unittest.TestCase):
    def run_helper(self, failing_command=None):
        with tempfile.TemporaryDirectory(prefix="native check ") as directory:
            root = Path(directory)
            scripts = root / ".github/scripts"
            scripts.mkdir(parents=True)
            shutil.copyfile(SCRIPT, scripts / SCRIPT.name)
            desktop = root / "desktop/src-tauri"
            desktop.mkdir(parents=True)
            config = {"bundle": {"externalBin": []}}
            (desktop / "tauri.dev.json").write_text(json.dumps(config))
            binaries = root / "bin"
            binaries.mkdir()
            log = root / "commands.jsonl"
            for command in ["bun", "cargo"]:
                stub = binaries / command
                stub.write_text(
                    f"#!{sys.executable}\n"
                    "import json, os, sys\n"
                    "from pathlib import Path\n"
                    "command = Path(sys.argv[0]).name\n"
                    "with open(os.environ['COMMAND_LOG'], 'a') as log:\n"
                    "    log.write(json.dumps({'command': command, 'args': sys.argv[1:], "
                    "'cwd': os.getcwd(), 'config': os.environ.get('TAURI_CONFIG')}) + '\\n')\n"
                    "sys.exit(17 if command == os.environ.get('FAIL_COMMAND') else 0)\n"
                )
                stub.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{binaries}{os.pathsep}{os.environ['PATH']}",
                "COMMAND_LOG": str(log),
                "FAIL_COMMAND": failing_command or "",
                "TAURI_CONFIG": '{"bundle":{"externalBin":["unexpected-sidecar"]}}',
            }
            result = subprocess.run(
                ["bash", str(scripts / SCRIPT.name)],
                cwd=binaries,
                env=env,
                capture_output=True,
                text=True,
            )
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            return result, calls, str(root), config

    def test_generates_icons_and_runs_locked_tests_with_dev_config(self):
        result, calls, root, config = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call["command"] for call in calls], ["bun", "cargo"])
        self.assertEqual(calls[0]["args"], ["run", "--cwd", "desktop", "icons"])
        self.assertEqual(
            calls[1]["args"],
            ["test", "--locked", "--manifest-path", "desktop/src-tauri/Cargo.toml"],
        )
        self.assertEqual([call["cwd"] for call in calls], [root, root])
        self.assertEqual(json.loads(calls[1]["config"]), config)

    def test_icon_failure_stops_before_cargo(self):
        result, calls, _, _ = self.run_helper("bun")
        self.assertEqual(result.returncode, 17)
        self.assertEqual([call["command"] for call in calls], ["bun"])

    def test_cargo_failure_fails_the_helper(self):
        result, calls, _, _ = self.run_helper("cargo")
        self.assertEqual(result.returncode, 17)
        self.assertEqual([call["command"] for call in calls], ["bun", "cargo"])


if __name__ == "__main__":
    unittest.main()

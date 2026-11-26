"""Real DSH end to end: the mock town + a real DeepSeek Harness (web profile `towntest`, isolated DSH_HOME under .dshtest)
with the plugin installed by `dsh plugin add`, her model = opencode-go deepseek-v4.1-flash.

The model key is read from the memory-bench DSH credentials file into the DSH child's environment only (never printed or written).
Every line of DSH output goes through redact() before it reaches the console or .dshtest/dsh.log.

    python -I test/real-dsh/launch.py [--games 2] [--visits 1] [--keep]
    python -I test/real-dsh/launch.py --dsh <prefix>/dsh.cmd --node-dir <Node 24 dir> --test-dir <dir> [--setup <plugin .tgz>] [--live]
    python -I test/real-dsh/launch.py ... --games 1 --visits 0 --agency 4 --row "fastTurnsPerSession: 1"

0.9.12 (owner 11-23 「适配下dsh新版本…以后更新插件相关的你就拉起dsh测试一下」): any DSH install (--dsh; the newest needs Node 24, --node-dir
goes first on PATH), its own test home (--test-dir, default .dshtest), --setup installs a packed plugin into a fresh `towntest` profile.
0.9.13: --agency N sends N decision turns (reasons ['pulled'], so she is always asked) after the games and visits; --row adds a config
line to the fishbowl-town row (e.g. "fastTurnsPerSession: 1" to rotate 心思 every turn); --web-port moves the test DSH off 3091; after DSH stops the workspace registry
(home/storages/workspace.json: order, pins, archive) is printed next to the plugin's current town sessions, ids only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEST = os.path.join(ROOT, '.dshtest')
DSH = r'F:\Olivia\ClaudeWork\memory-bench\dsh\prefix\dsh.cmd'
SECRETS = os.path.join(ROOT, 'secrets', 'outside-code.txt')
NODE_DIR = ''
PATCH = '''# dsh-town-plugin real-DSH test profile (isolated DSH_HOME). Model: opencode-go flash key passed in the launch environment by test/real-dsh/launch.py.
- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_API_KEY
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
- id: webserver
  config:
    host: 127.0.0.1
    port: 3091
- id: fishbowl-town
  config:
    eventsEverySeconds: 60
'''
CREDS = r'F:\Olivia\ClaudeWork\memory-bench\dsh\home\.credentials.yaml'
MOCK_PORT = 18931
WEB_PORT = 3091
SECRET = re.compile(r'(fbo_[A-Za-z0-9_-]{6,}|\bsk-[A-Za-z0-9_-]{8,}|(?i:token|key|secret)=[^&\s"]+)')


SECRET_EXTRA = []


def dec(raw: bytes) -> str:
    """DSH's console output on this PC is UTF-8 or the console code page (GBK)."""
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('gbk', 'replace')


def redact(s: str) -> str:
    for x in SECRET_EXTRA:
        s = s.replace(x, '***')
    return SECRET.sub(lambda m: m.group(0)[:4] + '***', s)


def model_key() -> str:
    text = open(CREDS, encoding='utf-8').read()
    m = re.search(r'^\s+OPENCODE_API_KEY:\s*(\S+)\s*$', text, re.M)
    if not m:
        raise SystemExit('no OPENCODE_API_KEY ref in the memory-bench credentials file')
    return m.group(1).strip('\'"')


def call(path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{MOCK_PORT}{path}', data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method='GET' if body is None else 'POST')
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))


def wait(pred, secs):
    end = time.time() + secs
    while time.time() < end:
        if pred():
            return True
        time.sleep(1)
    return False


def base_env():
    env = dict(os.environ)
    if NODE_DIR:
        env['PATH'] = NODE_DIR + os.pathsep + env.get('PATH', '')
    return env


def setup(tgz: str):
    """A fresh `towntest` profile in TEST/home with the packed plugin installed the way an owner does (dsh plugin add <file>)."""
    import shutil
    home = os.path.join(TEST, 'home')
    os.makedirs(os.path.join(TEST, 'ws'), exist_ok=True)
    local = os.path.join(TEST, os.path.basename(tgz))       # the profile keeps a file: link to it, so it lives with the test home
    if os.path.abspath(tgz) != local:
        shutil.copyfile(tgz, local)
    env = dict(base_env(), DSH_HOME=home, DSH_TELEMETRY='0')
    r = subprocess.run(['cmd', '/c', DSH, 'plugin', '--profile', 'towntest', 'add', local], cwd=os.path.join(TEST, 'ws'), env=env,
                       capture_output=True, timeout=600)
    print(redact(dec(r.stdout + r.stderr))[-3000:], flush=True)
    if r.returncode != 0:
        raise SystemExit(f'dsh plugin add failed ({r.returncode})')
    prof = os.path.join(home, 'profiles', 'towntest')
    pj = os.path.join(prof, 'package.json')
    pkg = json.load(open(pj, encoding='utf-8'))
    bundles = pkg.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
    if '@deepseek-ai/dsh-web-app' not in bundles:            # a profile made by `plugin add` has no app: boot the web one, like `dsh web`
        bundles.insert(1 if '@deepseek-ai/dsh-base' in bundles else 0, '@deepseek-ai/dsh-web-app')
        with open(pj, 'w', encoding='utf-8') as fh:
            json.dump(pkg, fh, ensure_ascii=False, indent=2)
    with open(os.path.join(prof, 'cordis.patch.yml'), 'w', encoding='utf-8') as fh:
        fh.write(PATCH)
    print(open(os.path.join(prof, 'package.json'), encoding='utf-8').read(), flush=True)


def set_row(config_yaml: str):
    """Rewrite the fishbowl-town row of the test profile's patch."""
    path = os.path.join(TEST, 'home', 'profiles', 'towntest', 'cordis.patch.yml')
    text = open(path, encoding='utf-8').read()
    head = text.split('- id: fishbowl-town')[0]
    head = re.sub(r'(- id: webserver\n  config:\n    host: 127\.0\.0\.1\n    port: )\d+', lambda m: m.group(1) + str(WEB_PORT), head)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(head + '- id: fishbowl-town\n  config:\n' + config_yaml)


def workspace_summary():
    """The workspace registry after the run (order, pins, archive) and the plugin's current town sessions: ids and titles only."""
    out = {}
    try:
        ws = json.load(open(os.path.join(TEST, 'home', 'storages', 'workspace.json'), encoding='utf-8'))
        g = ws.get('global', {})
        tables = (ws.get('tables') or {}).get('workspaces') or {}
        out['workspaceIds'] = [f"{w} ({tables.get(w, {}).get('title', '?')})" for w in g.get('workspaceIds', [])]
        out['pinnedSessionIds'] = g.get('pinnedSessionIds', [])
        out['archivedSessionIds'] = g.get('archivedSessionIds', [])
    except (OSError, ValueError) as e:
        out['workspace_error'] = str(e)
    try:
        st = json.load(open(os.path.join(TEST, 'home', 'fishbowl-town', 'state.json'), encoding='utf-8'))
        out['sessions'] = {k: v.get('sid') for k, v in (st.get('sessions') or {}).items() if isinstance(v, dict)}
        out['pinnedByUs'] = st.get('pinnedByUs', {})
    except (OSError, ValueError) as e:
        out['state_error'] = str(e)
    try:
        out['room'] = json.load(open(os.path.join(TEST, 'home', 'fishbowl-town', 'room.json'), encoding='utf-8'))
    except (OSError, ValueError):
        out['room'] = None
    return out


def drop_settings():
    """settings.json and its copies (.bak, .unreadable-*): once the owner chat binds her session or writes her persona, the plugin
    saves its fish list there, the 接入码 from FISHBOWL_TOWN_CODE included (seen 11-23 on DSH 0.2.1-rc.5). Run with --live again
    to clear a home whose last run was killed."""
    folder = os.path.join(TEST, 'home', 'fishbowl-town')
    for name in (os.listdir(folder) if os.path.isdir(folder) else []):
        if name.startswith('settings.json'):
            os.remove(os.path.join(folder, name))


def live(log, keep_settings=False, rows=''):
    """DSH against the real town; runs until Ctrl+C. The 接入码 reaches the plugin only through FISHBOWL_TOWN_CODE."""
    set_row('    eventsEverySeconds: 60\n' + rows)
    if not keep_settings:
        drop_settings()                                       # no saved persona / code: her card from the town decides
    code = open(SECRETS, encoding='utf-8').read().strip()
    env = dict(base_env(), DSH_HOME=os.path.join(TEST, 'home'), DSH_TELEMETRY='0', TZ='Asia/Shanghai',
               OPENCODE_API_KEY=model_key(), FISHBOWL_TOWN_CODE=code)
    SECRET_EXTRA.append(code)
    del code
    dsh = subprocess.Popen(['cmd', '/c', DSH, '--profile', 'towntest'], cwd=os.path.join(TEST, 'ws'), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    del env
    try:
        for raw in dsh.stdout:
            line = redact(dec(raw).rstrip())
            log.write(time.strftime('%H:%M:%S ') + line + '\n')
            log.flush()
            if 'fishbowl-town' in line or 'rror' in line:
                print(time.strftime('%H:%M:%S'), line[:300], flush=True)
            if re.search(r'https?://127\.0\.0\.1:\d+', line):
                with open(os.path.join(TEST, 'url.txt'), 'w', encoding='utf-8') as fh:
                    fh.write(raw.decode('utf-8', 'replace').strip())
    finally:
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(dsh.pid)], capture_output=True)
        if not keep_settings:
            time.sleep(1)
            drop_settings()                                   # the code written there during the run does not stay on disk


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=2)
    ap.add_argument('--visits', type=int, default=1)
    ap.add_argument('--keep', action='store_true', help='leave DSH and the mock running (Ctrl+C to stop)')
    ap.add_argument('--live', action='store_true', help='the real town (internal): code from secrets/outside-code.txt via env; no mock')
    ap.add_argument('--keep-settings', action='store_true', help='with --live: keep home/fishbowl-town/settings.json (e.g. a multi-fish list)')
    ap.add_argument('--dsh', default=DSH, help='the dsh.cmd of the DSH install to test (default: memory-bench 0.2.1-rc.5)')
    ap.add_argument('--node-dir', default='', help='a Node directory put first on PATH for DSH (the newest DSH needs Node 24)')
    ap.add_argument('--test-dir', default=TEST, help="this run's DSH_HOME parent (home/, ws/, logs); default .dshtest")
    ap.add_argument('--secrets', default=SECRETS, help="with --live: the file holding the test fish's 接入码 (never printed)")
    ap.add_argument('--setup', default='', help='install this plugin .tgz into a fresh towntest profile, then exit')
    ap.add_argument('--agency', type=int, default=0, help='0.9.13: this many decision turns (reasons pulled) after the games and visits')
    ap.add_argument('--agency-reasons', default='pulled', help='0.9.17: the reasons of each decision turn, turns split by ";" (the last one repeats), '
                    'e.g. "pulled;guest;table": she answers, rests, a guest still wakes her, an ordinary reason does not')
    ap.add_argument('--web-port', type=int, default=WEB_PORT, help='0.9.13: the DSH web port of the test profile (another DSH test on this PC may hold 3091)')
    ap.add_argument('--row', action='append', default=[], help='0.9.13: an extra config line for the fishbowl-town row, e.g. "fastTurnsPerSession: 1"')
    args = ap.parse_args()
    rows = ''.join(f'    {r.strip()}\n' for r in args.row if re.match(r'^[A-Za-z]\w*:\s*\S', r.strip()))
    globals().update(DSH=args.dsh, NODE_DIR=args.node_dir, WEB_PORT=args.web_port, TEST=os.path.abspath(args.test_dir), SECRETS=args.secrets)
    os.makedirs(TEST, exist_ok=True)
    if args.setup:
        return setup(os.path.abspath(args.setup))
    log = open(os.path.join(TEST, 'dsh.log'), 'a', encoding='utf-8')
    if args.live:
        return live(log, args.keep_settings, rows)
    if not os.path.exists(os.path.join(TEST, 'mock-code.txt')):
        import secrets as _s
        with open(os.path.join(TEST, 'mock-code.txt'), 'w', encoding='utf-8') as fh:
            fh.write('fbo_' + _s.token_hex(16))               # a code only the mock knows
    mock = subprocess.Popen([sys.executable, '-I', os.path.join(ROOT, 'mock', 'mock_town.py'), '--port', str(MOCK_PORT),
                             '--code-file', os.path.join(TEST, 'mock-code.txt')], stdout=subprocess.PIPE, text=True)
    mock.stdout.readline()
    mock_code = open(os.path.join(TEST, 'mock-code.txt'), encoding='utf-8').read().strip()
    SECRET_EXTRA.append(mock_code)
    set_row(f'    eventsEverySeconds: 60\n    base: http://127.0.0.1:{MOCK_PORT}/town/api/outside/\n' + rows)
    settings = os.path.join(TEST, 'home', 'fishbowl-town', 'settings.json')
    if os.path.exists(settings):
        os.remove(settings)                                   # the mock code reaches the plugin only through FISHBOWL_TOWN_CODE
    env = dict(base_env(), DSH_HOME=os.path.join(TEST, 'home'), DSH_TELEMETRY='0', TZ='Asia/Shanghai', OPENCODE_API_KEY=model_key(),
               FISHBOWL_TOWN_CODE=mock_code)
    dsh = subprocess.Popen(['cmd', '/c', DSH, '--profile', 'towntest'], cwd=os.path.join(TEST, 'ws'), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    del env
    lines = []

    def pump():
        for raw in dsh.stdout:
            line = redact(dec(raw).rstrip())
            lines.append(line)
            log.write(line + '\n')
            log.flush()
            if 'fishbowl-town' in line or 'rror' in line:
                print('  dsh|', line[:300], flush=True)
            if re.search(r'https?://127\.0\.0\.1:\d+', line) and 'url.txt' not in line:
                with open(os.path.join(TEST, 'url.txt'), 'w', encoding='utf-8') as fh:   # the local UI address, for screenshots
                    fh.write(raw.decode('utf-8', 'replace').strip())
    threading.Thread(target=pump, daemon=True).start()
    try:
        if not wait(lambda: any('开始在小镇值班' in x for x in lines), 180):
            raise SystemExit('the plugin never started; see .dshtest/dsh.log')
        t0 = time.time()
        for i in range(args.games):
            call('/mock/game', {'rounds': 3})
            wait(lambda: len(call('/mock/report')['games']) > i, 200)
        for i in range(args.visits):
            call('/mock/visit', {'lines': 4})
            wait(lambda: len(call('/mock/report')['visits']) > i, 200)
        seq = [[r.strip() for r in part.split(',') if r.strip()] for part in args.agency_reasons.split(';')] or [['pulled']]
        for i in range(args.agency):
            before = call('/mock/report').get('agency_turns', 0)
            call('/mock/agency', {'reasons': seq[min(i, len(seq) - 1)]})
            wait(lambda: call('/mock/report').get('agency_turns', 0) > before, 120)
        call('/mock/paint', {})
        wait(lambda: call('/mock/report')['unread'] == 0, 60)
        time.sleep(25)                                     # let her write the news note
        rep = call('/mock/report')
        took = [x['took'] for x in rep['log'] if x['outcome'] == 'answered']
        out = {'seconds': round(time.time() - t0), 'turns': len(rep['log']), 'user_agents': rep.get('user_agents'),
               'answered': len(took), 'timeouts': sum(1 for x in rep['log'] if x['outcome'] == 'timeout'),
               'took_s': {'min': min(took) if took else None, 'max': max(took) if took else None,
                          'mean': round(sum(took) / len(took), 2) if took else None},
               'games': rep['games'], 'visits': rep['visits'], 'unread_events': rep['unread'], 'agency_turns': rep.get('agency_turns'),
               'decisions': [{k: d.get(k) for k in ('action', 'next_wake', 'note')} for d in rep.get('decisions', [])],
               'answers': [x.get('answer') for x in rep['log'] if x['outcome'] == 'answered']}
        with open(os.path.join(TEST, 'real-dsh-report.json'), 'w', encoding='utf-8') as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
        print(json.dumps({k: v for k, v in out.items() if k != 'answers'}, ensure_ascii=False), flush=True)
        if args.keep:
            print('keeping DSH + mock up; Ctrl+C to stop', flush=True)
            while True:
                time.sleep(5)
    finally:
        subprocess.run(['taskkill', '/T', '/PID', str(dsh.pid)], capture_output=True)   # ask first (lets DSH flush its sessions)
        if dsh.poll() is None and not wait(lambda: dsh.poll() is not None, 15):
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(dsh.pid)], capture_output=True)
        mock.kill()
        print('workspace after the run:', json.dumps(workspace_summary(), ensure_ascii=False, indent=1), flush=True)


if __name__ == '__main__':
    main()

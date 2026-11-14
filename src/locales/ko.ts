// 한국어 메시지. 키는 src/locales/en.ts 와 정확히 같아야 한다(컴파일러와 test/i18n.test.ts 가 확인).
// 판정 종류(kind)와 JSON 키는 번역하지 않는다.

import type { MessageKey } from './en.js';

export const ko: Record<MessageKey, string> = {
  'help': `mcp-launch-doctor {version} — stdio MCP 서버를 앱이 띄우는 방식대로 실행해 왜 실패하는지 보여 줍니다.

사용법:
  mcp-launch-doctor check [옵션]                         클라이언트 설정 파일에 있는 서버를 진단
  mcp-launch-doctor run [옵션] -- <명령> [인자...]       서버 명령 하나를 진단(CI 에 알맞음)
  mcp-launch-doctor wrap -- <명령> [인자...]             서버를 실행하되 JSON-RPC 가 아닌 stdout 줄은 stderr 로 돌림
  mcp-launch-doctor demo [--json] [--lang <언어>]        동봉한 연습용 목(mock) 서버로 연습 실행

옵션:
  --client <이름>     {clients} 또는 all (check 기본값: all, run: 그 클라이언트의 제한 시간·조각 형식 사용)
  --config <경로>     기본 위치 대신 이 설정 파일을 읽음(.toml = codex)
  --server <이름>     이 서버만 점검
  --env <프로필>      {profiles} 를 쉼표로 나열하거나 all (check 기본값: gui,shell, run 기본값: shell)
  --timeout <ms>      모든 서버의 시작 제한 시간(클라이언트 제한보다 우선)
  --no-retry          시간 초과 원인을 찾는 재시도를 하지 않음
  --dry-run           무엇을 실행할지 보여 주기만 하고 아무것도 실행하지 않음
  --yes               실행 전 확인을 묻지 않음(check)
  --json              기계가 읽는 출력(schemaVersion 1)
  --fail-on <등급>    {failOn} (기본값: error)
  --lang <언어>       {langs} (MCP_LAUNCH_DOCTOR_LANG, LC_ALL, LC_MESSAGES, LANG 도 봄)
  -h, --help          이 도움말
  -v, --version       버전

종료 코드: 0 통과, 1 --fail-on 등급 이상 발견, 2 사용법·설정 오류.
안전: check 와 run 은 설정에 적힌 명령을 그대로 실행합니다. 확실하지 않으면 먼저 --dry-run 을 쓰세요.`,

  'err.unknown_command': '알 수 없는 명령 "{command}". 명령: {commands}.',
  'err.unexpected_argument': '예상하지 못한 인자 "{value}". 서버 명령은 "--" 뒤에 쓰세요.',
  'err.help_hint': '도움말: mcp-launch-doctor --help',
  'err.bad_option': '{message}',
  'err.unknown_option': '알 수 없는 옵션 "{option}".',
  'err.option_value': '{option} 옵션에는 값이 필요합니다.',
  'err.no_servers_in_config': '{path} 에 stdio 서버가 없습니다(mcpServers, servers 또는 [mcp_servers.*] 키가 필요합니다).',
  'fix.masked_note': '***로 표시된 값은 가려진 것입니다. 그 자리에는 기존 값을 그대로 두세요.',
  'err.bad_choice': '{option} 값 "{value}" 가 올바르지 않습니다. 다음 중 하나: {choices}.',
  'err.missing_command': '"--" 뒤에 서버 명령을 주세요. 예: mcp-launch-doctor {sub} -- node server.js',
  'err.bad_timeout': '--timeout "{value}" 가 올바르지 않습니다. 양의 밀리초 숫자를 쓰세요.',
  'err.config_parse': '{source} 를 읽지 못했습니다: {message}',
  'err.config_missing': '설정 파일이 없습니다: {path}',
  'err.client_required': '"{path}" 가 어느 클라이언트 설정인지 알 수 없습니다. --client 를 붙이세요({clients}).',
  'err.no_configs': '다음 클라이언트의 기본 설정 위치에서 stdio MCP 서버를 찾지 못했습니다: {clients}. --config <경로> --client <이름> 을 쓰세요.',
  'err.no_server_match': '설정 파일에 "{name}" 이라는 stdio 서버가 없습니다.',
  'warn.config_skipped': '경고: {source} 를 건너뜀: {message}',

  'demo.notice': '연습 모드: 동봉된 연습용 픽스처(목(mock) 서버)이며 실제 MCP 서버가 아닙니다. 각 서버는 일부러 stdio 규칙을 어깁니다.',
  'demo.next': '다음 단계: mcp-launch-doctor check  (내 설정 파일의 서버를 진단)',

  'table.server': '서버',
  'table.env': '환경',
  'table.result': '판정',
  'table.time': '첫 응답',
  'table.tools': '도구',
  'summary': '요약: 정상 {ok}, 경고 {warn}, 오류 {error} (실행 {total}회).',
  'progress': '{server} [{profile}] 점검 중 ...',

  'confirm.header': 'mcp-launch-doctor 가 설정에 적힌 그대로 다음 명령 {count}개를 실행합니다:',
  'confirm.question': '지금 실행할까요? [y/N] ',
  'confirm.aborted': '취소했습니다. 아무것도 실행하지 않았습니다.',

  'dryrun.header': '시험 실행(dry run) — 아무것도 실행하지 않습니다. 찾은 서버:',
  'dryrun.limit': '시작 제한 시간',
  'dryrun.not_launched': '실행하지 않음',
  'skipped.header': '건너뜀:',
  'skipped.remote': '{name} ({client}): stdio 서버가 아님({detail})',
  'skipped.disabled': '{name} ({client}): 설정에서 꺼져 있음',
  'skipped.invalid': '{name} ({client}): 잘못된 항목("command" 없음)',

  'section.details': '{server} [{profile}] 자세히',
  'section.fix': '고칠 조각',
  'section.stderr': 'stderr 마지막 줄(비밀값 가림):',
  'section.source': '설정: {source}',

  'limit.flag': '--timeout',
  'limit.config': '{client} 설정값',
  'limit.client_default': '{client} 기본값',
  'limit.env': 'MCP_TIMEOUT',
  'limit.tool_default': '클라이언트 제한 시간 알 수 없음, 도구 기본값',
  'limit.demo': '연습용 제한 시간',

  'phase.initialize': 'initialize',
  'phase.tools/list': 'tools/list',
  'phase.after_handshake': '핸드셰이크 이후',

  'verdict.ok': '핸드셰이크 정상: {name} {version}, 프로토콜 {protocol}, initialize 응답 {initMs} ms, 도구 {tools}개.',
  'verdict.not_found': '명령을 찾지 못했습니다: "{command}" ({errno}). 이 PATH 로는 앱이 서버를 띄울 수 없습니다.',
  'verdict.not_found_cwd': '작업 폴더(cwd)가 없습니다: {path}',
  'verdict.interpreter_missing': '명령은 찾았지만 인터프리터 "{interpreter}" 가 PATH 에 없습니다(종료 코드 {code}). #!/usr/bin/env {interpreter} 로 시작하는 스크립트는 명령을 절대 경로로 줘도 PATH 에 인터프리터가 있어야 합니다.',
  'verdict.early_exit': '서버가 핸드셰이크를 마치기 전 {phase} 단계에서 종료했습니다(코드 {code}). 아래 stderr 꼬리에 대개 이유가 있습니다.',
  'verdict.startup_timeout': '{limitMs} ms 안에 {phase} 응답이 없었습니다({limitLabel}).',
  'verdict.protocol_error_id': '보낸 요청과 맞지 않는 id {ids} 의 응답이 왔습니다. 응답 id 는 요청 id 와 정확히 같아야 합니다.',
  'verdict.protocol_error_init': 'initialize 가 오류를 돌려줬습니다: {message} (코드 {code}).',
  'verdict.protocol_error_noversion': 'initialize 결과에 protocolVersion 이 없습니다.',
  'verdict.protocol_error_tools': 'tools/list 가 오류를 돌려줬습니다: {message} (코드 {code}).',
  'verdict.version_mismatch': '서버가 protocolVersion {got} 으로 답했습니다. 요즘 클라이언트는 {supported} 만 받아들이고 그 밖이면 연결을 끊습니다.',
  'verdict.stdout_pollution': 'stdout 의 {count}줄이 JSON-RPC 가 아닙니다. stdout 에는 MCP 메시지만 써야 하고 로그는 stderr 로 보내야 합니다.',
  'verdict.framing_warning': '프레이밍 문제: {details}. 일부 클라이언트는 이런 줄을 거부하거나 버립니다.',
  'verdict.unresolved_variable': '실행하지 않음: 다음 자리표시자를 풀 수 없습니다: {placeholders}.',
  'verdict.npx_prompt_risk': 'npx 에 -y 가 없으면 "Ok to proceed?" 설치 확인에서 멈출 수 있습니다.',
  'verdict.slow_start': '첫 응답이 {initMs} ms 걸려 제한 시간 {limitMs} ms 의 절반을 넘었습니다({limitLabel}).',
  'verdict.unsupported': '이 환경 프로필은 아직 {platform} 에서 지원하지 않습니다. shell 만 됩니다.',

  'framing.bom': '바이트 순서 표시(BOM) ×{n}',
  'framing.crlf': 'CRLF 줄 끝 ×{n}',
  'framing.blank': '빈 줄 ×{n}',
  'framing.invalid_utf8': '잘못된 UTF-8 ×{n}',
  'framing.partial': '줄바꿈 없이 끝난 마지막 줄(partial_line) ×{n}',
  'lines.item': '{line}번째 줄 @ {offset}바이트 [{kind}{flags}] {preview}',

  'cause.buffering': '원인: 출력 버퍼링 — PYTHONUNBUFFERED=1 로 다시 띄우니 {ms} ms 에 응답했습니다.',
  'cause.first_run_install': '원인: 첫 실행 설치 — 같은 명령을 다시 실행하니 {ms} ms 에 응답했습니다.',
  'cause.unknown': '원인: 알 수 없음(재시도로도 해결되지 않았거나 재시도를 껐습니다).',

  'fix.not_found': '절대 경로({absolute})를 쓰고, 그 폴더가 들어간 PATH 를 서버 env 에 넣으세요. 기존 항목에 합치세요:',
  'fix.not_found_script': '절대 경로({absolute})를 쓰고, "{interpreter}" 폴더까지 담은 PATH 를 서버 env 에 넣으세요. 이 파일은 #!/usr/bin/env {interpreter} 로 시작해서 명령만 바꾸면 다시 실패합니다. 기존 항목에 합치세요:',
  'fix.not_found_anywhere': '"{command}" 는 셸 PATH 에도 없습니다. 설치하거나 전체 경로를 쓰세요.',
  'fix.cwd_missing': '{path} 폴더를 만들거나 설정의 "cwd" 를 고치세요.',
  'fix.interpreter_missing': '"{interpreter}" 의 폴더({absolute})를 서버 env 의 PATH 에 넣으세요. 기존 항목에 합치세요(다른 env 값은 그대로 두세요):',
  'fix.buffering': 'Python 출력 버퍼링을 끄세요(또는 python3 -u 로 실행). 기존 항목에 합치세요:',
  'fix.first_run_codex': '첫 실행 때 패키지를 내려받습니다. Codex 의 시작 제한 시간을 늘리거나 패키지를 미리 한 번 설치하세요:',
  'fix.timeout_codex': 'Codex 가 이 서버를 띄울 시간을 늘리세요:',
  'fix.first_run_claude_code': '첫 실행 때 패키지를 내려받습니다. 더 긴 제한 시간으로 Claude Code 를 시작하거나 패키지를 미리 한 번 설치하세요:',
  'fix.timeout_claude_code': '더 긴 시작 제한 시간으로 Claude Code 를 시작하세요:',
  'fix.first_run_generic': '첫 실행 때 패키지를 내려받습니다. 미리 한 번 설치하고(예: npm install -g <패키지>) 설정이 설치된 명령을 가리키게 하세요.',
  'fix.timeout_generic': '서버가 {limitMs} ms 안에 답하지 않았습니다. stderr 꼬리를 보고 initialize 에 더 빨리 답하게 하거나(느린 준비는 핸드셰이크 뒤로), 클라이언트에 시작 제한 시간 설정이 있으면 늘리세요.',
  'fix.wrap': '가장 좋은 해결: 서버가 로그를 stderr 로 쓰게 고치기. 그 전까지는 명령 앞에 wrap 을 끼우세요 — JSON-RPC 줄만 stdout 으로 내보내고 나머지는 stderr 로 돌립니다:',
  'fix.wrap_npx': '가장 좋은 해결: 서버가 로그를 stderr 로 쓰게 고치기. 그 전까지는 명령 앞에 wrap 을 끼우세요 — JSON-RPC 줄만 stdout 으로 내보내고 나머지는 stderr 로 돌립니다. 이 도구를 npx 로 실행해서 지금 위치는 언제든 지워질 수 있는 npx 캐시 폴더이므로, 버전({version})을 고정한 npx 로 wrap 을 띄웁니다. 고정된 파일 경로를 쓰려면 npm i -g mcp-launch-doctor 로 한 번 설치한 뒤 다시 검사하세요:',
  'fix.npx_yes': 'npx 가 설치 확인을 기다리지 않도록 -y 를 붙이세요:',
  'fix.version': '서버(또는 서버의 MCP SDK)를 업데이트해 {got} 대신 현재 프로토콜 버전으로 답하게 하세요.',
  'fix.early_exit': 'stderr 가 알려 주는 문제(대개 빠진 env 값이나 의존성)를 고친 뒤 다시 실행하세요.',
  'fix.unresolved': '셸에서 변수를 설정하거나 자리표시자를 실제 값으로 바꾸세요. ${input:...} 과 envFile 은 아직 mcp-launch-doctor 가 읽지 않습니다.',
  'fix.framing': '메시지마다 \\n 하나로만 끝나는 UTF-8 한 줄로 쓰세요: BOM·\\r·빈 줄 없이.',

  'retry.rerun': '재시도(같은 명령 다시 실행): {result}',
  'retry.unbuffered': '재시도(PYTHONUNBUFFERED=1): {result}',
  'retry.ok': '{ms} ms 에 응답',
  'retry.failed': '여전히 응답 없음',

  'wrap.spawn_failed': '[wrap] {command} 를 시작하지 못했습니다: {message}',
};

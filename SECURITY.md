# Security policy / 보안 정책

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

Note / 참고: `check` and `run` start the commands written in your MCP config files, as your apps would; use `--dry-run` first if unsure. The tool does not open any network port and does not send data anywhere. / `check`·`run` 은 앱처럼 설정 파일에 적힌 명령을 실행합니다. 확실하지 않으면 먼저 `--dry-run` 을 쓰세요. 이 도구는 네트워크 포트를 열거나 데이터를 외부로 보내지 않습니다.

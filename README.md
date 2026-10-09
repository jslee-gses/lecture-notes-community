# Lecture Notes for Codex

한국어·영어 유튜브 강의의 원본 자막을 읽어 2단계 목차, 한국어 요약노트와 용어집, 시점별 자막을 만들고 공유 페이지로 보여주는 Codex 플러그인입니다. 영어 강의에는 원문과 한국어 번역을 함께 표시합니다. **Windows Codex 데스크톱**에서 **최대 3시간**의 강의를 지원합니다.

## 설치

Codex CLI가 설치된 PowerShell에서 다음을 실행합니다.

```powershell
codex plugin marketplace add jslee-gses/lecture-notes-community --ref main
codex plugin add lecture-notes@lecture-notes-community
```

Codex를 다시 열고 대화에 `$lecture-notes https://www.youtube.com/watch?v=40JNj2zjnQc`처럼 입력합니다. 별도 서비스 계정이나 API 키는 필요하지 않습니다. 처음 실행할 때 Deno와 yt-dlp의 고정 버전을 공식 배포처에서 작업 폴더의 `.lecture-notes/tools`로 다운로드하고 SHA-256을 검사합니다. 환경에 따라 Codex가 다운로드와 실행을 승인해 달라고 요청할 수 있습니다.

Codex는 자막 전체를 순서대로 읽어 강의 맥락과 반복 용어를 먼저 파악합니다. 이어서 근거가 있는 오인식만 보수적으로 교정하고 목차·요약·용어집을 작성합니다. 영어 강의는 제공자가 올린 원본 영어 자막을 우선 사용하고, 없으면 원본 영어 자동 자막을 사용합니다. 각 영어 자막 구간에 한국어 번역을 하나씩 작성하며 목차·요약·용어집은 한국어로 씁니다. YouTube 영상이나 음성 파일을 내려받지 않습니다. 원본 언어가 불명확하면 언어를 확인해야 하고, 해당 원본 자막이 없으면 이유를 알려주고 중단합니다. YouTube 쪽 접근 제한으로 자막 수집이 실패할 수도 있습니다.

## 결과와 공유

최종 JSON과 모든 중간 파일은 현재 작업 폴더의 `.lecture-notes/runs/<run-id>/`에 남습니다. 플러그인은 **검증된 `lecture.json`만** 공용 Railway 서버에 업로드하고 공유 URL을 알려줍니다. 업데이트된 플러그인으로 새로 업로드한 강의의 **제목과 내용은 누구나 방문할 수 있는 공개 목록에 표시**됩니다. 목차, 요약, 용어집, 자막과 원본 영상 시점을 로그인 없이 볼 수 있습니다. 영어 강의의 자막은 영어 원문과 한국어 번역을 함께 검색할 수 있습니다. 기존 업로드와 이전 플러그인의 업로드는 공개 목록에 표시되지 않습니다. 공유 결과는 업로드 후 **90일**에 만료되며 정기 정리 작업이 DB에서 삭제합니다.

업로드가 실패해도 로컬 JSON은 유지됩니다. 같은 실행 디렉터리에서 `upload` 명령만 다시 실행하면 같은 `run_id`와 본문으로 재시도합니다. 익명 업로드는 기본적으로 IP당 시간당 3건·하루 10건, 서비스 전체 하루 200건, JSON당 10 MiB로 제한됩니다. 429 응답의 `Retry-After`를 따르세요. 서버 운영자는 남용 상황에 따라 제한을 조정하거나 신규 업로드를 일시 중단할 수 있습니다.

## 개발과 배포

플러그인은 [`plugins/lecture-notes`](plugins/lecture-notes), FastAPI 서버는 [`server`](server)에 있습니다. 공유 JSON의 계약은 한국어 1.0용 [`lecture.schema.json`](plugins/lecture-notes/schema/lecture.schema.json)과 영어·한국어 병기 2.0용 [`lecture-v2.schema.json`](plugins/lecture-notes/schema/lecture-v2.schema.json)이 정의합니다. 서버는 PostgreSQL에 JSON과 불투명 공유 토큰을 저장합니다.

로컬 검증:

```powershell
deno check --config plugins/lecture-notes/deno.json plugins/lecture-notes/scripts/cli.ts
deno test --allow-read --allow-write --allow-run --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/*.test.ts
python -m pip install -r server/requirements.txt
python -m pytest -q server/tests
```

PostgreSQL 통합 테스트에는 `TEST_DATABASE_URL`을 지정합니다. GitHub Actions는 PostgreSQL 서비스를 켜고 이를 실행하며 Docker 빌드, 플러그인 테스트, Windows 도구 캐시 테스트도 수행합니다.

Railway 배포에는 이 저장소 루트의 `Dockerfile`, PostgreSQL 서비스, `DATABASE_URL`, `PUBLIC_BASE_URL`, `IP_HASH_SECRET`가 필요합니다. `IP_HASH_SECRET`는 서버에만 두고 저장소나 플러그인에 넣지 마세요. `TRUSTED_PROXY_CIDRS`는 실제 Railway 유입 프록시의 피어 주소를 확인한 뒤 설정해야 전달된 `X-Real-IP`를 사용할 수 있습니다. 서버는 시작 시 스키마를 적용하고 매시간 만료 데이터를 정리합니다. GitHub 배포에는 CI 성공 후 배포하는 Railway 설정을 사용합니다.

공식 OpenAI 플러그인 디렉터리 게시는 이 GitHub 마켓플레이스 공개와 별도의 심사 절차입니다.

코드는 [MIT 라이선스](LICENSE)로 공개합니다.

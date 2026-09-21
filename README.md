# Wiki Viki

SvelteKit, JavaScript, Bun, PostgreSQL 및 OpenAI Responses API로 만든 문서 중심의 사내 위키입니다.

## 설치 및 실행

`.env.example`을 `.env`로 복사하고 `DATABASE_URL`을 설정하세요. OpenAI API 키는 선택 사항입니다. API 키가 없어도 DOCX/PDF/XLSX/PPTX에서 추출한 텍스트로 기본 초안 하나를 만들 수 있으며, 이 경우 의미 기반 콘텐츠 보호 검사는 건너뜁니다.

```bash
bun install
bun run migrate
bun run seed
bun run dev
```

`bun run seed`는 Wiki Viki 운영에 필요한 정책·도움말 문서를 만들고 `seed-data/`의 모든 DOCX/PDF 파일을 처리합니다. 특정 원본 파일 처리에 실패해도 나머지 파일은 계속 처리됩니다.

참조 HTML의 예시 문서는 `bun run seed:prototype`으로 적재합니다. `seed-data/prototype-documents.json`에는 원본의 본문·별칭·출처를 추출해 보관했습니다. RFCC, 산단스팀, 상압증류탑, 촉매재생탑, OEC, 정비 요청 프로세스는 게시 문서로, 교대 인수인계 체크리스트는 원본처럼 검토용 초안으로 생성합니다. 모든 문서에 프로토타입 예시임을 표시합니다. 원본 화면의 조회수·상대 시각·토론 건수는 가져오지 않습니다.

이 명령은 기존 제목·슬러그·별칭과 충돌하는 항목을 건너뛰므로 반복 실행해도 사용자 편집을 덮어쓰거나 초안을 중복 생성하지 않습니다. 본문에서 아직 게시되지 않은 초안을 가리키는 링크를 열면 초안 검토 화면으로 이동할 수 있는 안내가 표시됩니다. Node.js 환경에서는 `node --env-file=.env scripts/seed-prototype.js`로 같은 작업을 실행할 수 있습니다.

## Vercel 배포

[Vercel용 SvelteKit 어댑터](https://vercel.com/docs/frameworks/full-stack/sveltekit)를 사용하며, 서버 코드는 Node.js 22 런타임에서 실행됩니다.

1. Vercel에서 저장소를 가져오고 Framework Preset을 **SvelteKit**, Node.js Version을 **22.x**로 설정합니다.
2. Install Command는 `bun install --frozen-lockfile`, Build Command는 `bun run build`로 설정합니다. Output Directory는 기본값을 유지합니다.
3. 환경 변수에 Neon PostgreSQL 연결 문자열인 `DATABASE_URL`을 설정합니다. AI 기능을 사용하려면 `OPENAI_API_KEY`를 추가하고, 필요하면 `OPENAI_MODEL`도 설정합니다.
4. 배포 전에 해당 DB의 `DATABASE_URL`을 설정한 로컬 환경에서 `bun run migrate`를 실행합니다. 초기 데이터가 필요하면 `bun run seed`도 실행한 뒤 배포합니다.

별도의 `vercel.json`은 필요하지 않습니다. 마이그레이션과 시드는 배포 빌드에서 자동 실행되지 않습니다.

## 검증

```bash
bun run check
bun run build
```

모든 편집 및 토론 사용자 이름은 `Editor-01` 또는 `Operator-A` 형식의 익명 식별자를 사용해야 합니다. AI 결과는 항상 초안 생성 → 담당자 검토 → 게시 절차를 거치며, 게시 전에 정규식·키워드 및 의미 기반 콘텐츠 보호 검사를 수행합니다.

## 프로토타입 화면 구현

기존 SvelteKit 2 · Svelte 5 · JavaScript · PostgreSQL/Neon · OpenAI Responses API · Vercel 구성을 유지합니다. Excel 읽기에는 `read-excel-file`, PPTX 읽기에는 기존 DOCX 파서에서도 사용하는 `jszip`·`@xmldom/xmldom`을 직접 의존성으로 등록했습니다. DB 마이그레이션은 없습니다.

- 홈: 검색 우선, 활동 대시보드, 실제 위키 링크 기반 지식 지도. 통계는 DB에서 계산하며 조회수나 방문 이력을 가정하지 않습니다.
- 검색: 제목·본문·별칭 검색, 자동완성 및 키보드 탐색, 제목 기준 분야 필터, 여러 게시 문서를 종합한 AI 설명과 문단별 출처 링크.
- 문서: 목차 접기, 관련 문서, 별칭을 포함한 정확한 역링크, 편집·역사·토론 연결.
- 위키파이어: 모달 및 독립 페이지, DOCX/PDF/XLSX/PPTX 선택·드래그 업로드, 용량·형식 검사, 처리 상태와 오류 안내. 원본 하나에서 최대 8개의 용어별 초안을 생성하고 서로 연결하며, 같은 원본의 초안은 한 트랜잭션으로 저장합니다.
- 초안: 상태별 필터, 저장된 초안 미리보기와 초안 간 이동, 검사 사유, 수정 내용 저장 후 게시. Neon JSONB 저장 호환성 수정.
- 테마: 참조의 베이지·오렌지·올리브 색상과 로컬 글꼴, 반응형 화면, 기존 다크 모드 설정 유지.

AI 설명은 `/api/answer`에서 기존 `OPENAI_API_KEY`와 `OPENAI_MODEL`을 사용합니다. 검색된 최대 6개 게시 문서를 근거로 Responses API의 [구조화된 출력](https://developers.openai.com/api/docs/guides/structured-outputs)을 요청하고, 출처 ID를 검증합니다. 키가 없거나 이용 한도 초과·연결 오류가 발생하면 안내와 일반 검색 결과를 유지합니다. AI 실패를 생성된 답변으로 대체하지 않습니다. 벡터 DB나 새로운 AI 제공자는 사용하지 않습니다.

Excel은 `.xlsx`의 시트 이름과 셀 값을 시트 순서대로 읽고, PowerPoint는 `.pptx`의 텍스트와 표를 슬라이드 순서대로 읽습니다. 최대 용량은 기존과 동일한 10MB입니다. Excel 수식은 파일에 저장된 계산 결과를 읽으며 새로 계산하지 않습니다. 서식·차트·이미지 OCR·발표자 노트·암호 파일은 지원하지 않습니다. 구형 `.xls`·`.ppt`는 Excel/PowerPoint에서 `.xlsx`·`.pptx`로 다시 저장한 뒤 업로드하세요.

```bash
bun run test
bun run check
bun run build
```

단위 테스트는 링크·별칭 해석, 검색어 정리, 여러 초안의 구조 검증, 한국어 용어 연결 및 AI 출처 검증을 확인합니다. 초기에는 로컬 AI 모의 서버로 통합 흐름을 검사했습니다. 2026-09-21 키 갱신 후에는 실제 OpenAI `gpt-5-mini`로 다중 문서 검색 답변과 출처 표시, DOCX의 용어별 초안 생성, 의미 기반 검사, 초안 수정·게시·리비전 생성을 확인했습니다. 검증용 DB 레코드는 정리하고 HTML에서 가져온 예시 7개만 추가로 유지했습니다. 상세 결과는 [실제 AI 검증 기록](docs/verification-2026-09-21.md)에 있습니다.

Windows에서는 Vercel 어댑터의 배포 디렉터리 심볼릭 링크 생성에 OS 권한이 필요할 수 있습니다. 이 환경에서 일반 빌드는 앱 컴파일 후 해당 단계에서 `EPERM`이 발생합니다. Vercel의 Linux 빌드 환경에서는 이 Windows 권한 제약이 적용되지 않습니다.

이 작업에서는 저장소 설정을 바꾸지 않고, 임시 Node 실행 도구에서 배포 디렉터리 링크만 Windows 디렉터리 정션으로 생성해 Vercel 패키징까지 완료되는 것을 추가 확인했습니다. 기본 빌드 명령의 OS 권한 요구 사항은 그대로입니다.

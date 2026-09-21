# Wiki Viki

SvelteKit, JavaScript, Bun, PostgreSQL 및 OpenAI Responses API로 만든 문서 중심의 사내 위키입니다.

## 설치 및 실행

`.env.example`을 `.env`로 복사하고 `DATABASE_URL`을 설정하세요. OpenAI API 키는 선택 사항입니다. API 키가 없어도 DOCX/PDF/PPTX에서 추출한 텍스트로 검토용 초안을 만들 수 있으며, 이 경우 의미 기반 콘텐츠 보호 검사는 건너뜁니다.

```bash
bun install
bun run migrate
bun run seed
bun run dev
```

`bun run seed`는 Wiki Viki 운영에 필요한 정책·도움말 문서를 만들고 `seed-data/`의 모든 DOCX/PDF 파일을 처리합니다. 특정 원본 파일 처리에 실패해도 나머지 파일은 계속 처리됩니다.

## Vercel 배포

[Vercel용 SvelteKit 어댑터](https://vercel.com/docs/frameworks/full-stack/sveltekit)를 사용하며, 서버 코드는 Node.js 22 런타임에서 실행됩니다.

1. Vercel에서 저장소를 가져오고 Framework Preset을 **SvelteKit**, Node.js Version을 **22.x**로 설정합니다.
2. Install Command는 `bun install --frozen-lockfile`, Build Command는 `bun run build`로 설정합니다. Output Directory는 기본값을 유지합니다.
3. 환경 변수에 Neon PostgreSQL 연결 문자열인 `DATABASE_URL`을 설정합니다. AI 기능을 사용하려면 `OPENAI_API_KEY`를 추가하고, 필요하면 `OPENAI_MODEL`도 설정합니다.
4. 배포 전에 해당 DB의 `DATABASE_URL`을 설정한 로컬 환경에서 `bun run migrate`를 실행합니다. 초기 데이터가 필요하면 `bun run seed`도 실행한 뒤 배포합니다.

별도의 `vercel.json`은 필요하지 않습니다. 마이그레이션과 시드는 배포 빌드에서 자동 실행되지 않습니다.

## 검증

```bash
bun run test
bun run check
bun run build
```

모든 편집 및 토론 사용자 이름은 `Editor-01`, `Operator-07` 또는 `Operator-A` 형식의 익명 식별자를 사용해야 합니다. AI 결과는 항상 초안 생성 → 담당자 검토 → 게시 절차를 거칩니다. 원문 초안과 시연 초안은 의미 기반 AI 검사를 생략하며 검토 화면에 이를 표시합니다.

## 프로토타입 화면과 기능

크림·주황·올리브 테마에 검색 우선·활동 대시보드·지식 지도 홈, 자동완성 및 분야 검색, 문서 간 링크, 출처, 조회수와 초안 검토를 제공합니다. **AI 위키파이어**에서 DOCX·PDF·PPTX 파일을 선택하거나 끌어 놓으세요. 파일은 40MB까지, 추출 텍스트는 12만 자까지 지원합니다. 실제 배포 서비스의 요청 크기 제한은 별도로 적용됩니다.

첨부 프로토타입의 예시는 **공장약어집.pdf 예시로 시연** 버튼으로 검토용 초안을 생성해 확인할 수 있습니다. 홈에는 실제 데이터 통계를 표시합니다. API 크레딧 부족 등의 오류가 발생하면 사용자가 원문 기반 초안을 선택할 수 있습니다.

기존 환경에서는 `bun run migrate`를 한 번 실행해 분야·설명·출처·조회수 열을 추가하세요. 상세 기능과 검증 방법은 [프로토타입 구현 문서](docs/prototype-implementation.md)를 참고하세요.

# Wiki Viki

SvelteKit, JavaScript, Bun, PostgreSQL 및 OpenAI Responses API로 만든 문서 중심의 사내 위키입니다.

## 설치 및 실행

`.env.example`을 `.env`로 복사하고 `DATABASE_URL`을 설정하세요. OpenAI API 키는 선택 사항입니다. API 키가 없어도 DOCX/PDF에서 추출한 텍스트로 검토용 초안을 만들 수 있으며, 이 경우 의미 기반 콘텐츠 보호 검사는 건너뜁니다.

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
bun run check
bun run build
```

모든 편집 및 토론 사용자 이름은 `Editor-01` 또는 `Operator-A` 형식의 익명 식별자를 사용해야 합니다. AI 결과는 항상 초안 생성 → 담당자 검토 → 게시 절차를 거치며, 게시 전에 정규식·키워드 및 의미 기반 콘텐츠 보호 검사를 수행합니다.

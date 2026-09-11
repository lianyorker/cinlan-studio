# Cinlan Studio

Cinlan Studio는 이미지 생성, 이미지 편집, 구조화된 텍스트 생성, 영구적인 제작 기록을 제공하는 AI 제작 워크스페이스입니다. `0.2.9`는 Next.js BFF, PostgreSQL Creative Core, 독립 Worker로 구성됩니다.

[English](./README.md) | [简体中文](./README.zh.md) | [日本語](./README.ja.md) | **한국어**

## 주요 기능

- Text-to-image, 단일 이미지 편집, 최대 4개의 참조 이미지 입력.
- 다중 출력, 개별 취소, 재시도, 새로고침 복구, 영구 작업 이벤트.
- Markdown/GFM 제목, 목록, 표, 링크, 코드 블록 렌더링.
- 스크롤 가능한 텍스트 기록과 임베디드 페이지에서도 동작하는 결과 복사.
- 원본 이미지 스트리밍, WebP 썸네일, ETag, Owner 단위 접근 격리.
- 체크무늬 또는 단순 배경만 제거하고 텍스트와 버튼을 보존하는 실제 alpha PNG 생성.
- Sub2API 로그인, 2FA, 임베디드 SSO, 서버 관리 owner/group 자격 증명.

## 개발

Node.js 22 또는 24와 PostgreSQL 14 이상이 필요합니다.

```bash
npm ci
npm run db:migrate
npm run dev
```

프로덕션에서는 `CREATIVE_IN_PROCESS_WORKER=false`를 설정하고 `npm run worker:creative`를 별도 서비스로 실행합니다. 자세한 내용은 [deployment guide](./deploy/DEPLOY.md)를 참조하세요.

## License

[MIT](./LICENSE)

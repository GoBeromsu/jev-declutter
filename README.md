# Jev Declutter

Instagram, X, YouTube에서 주의를 빼앗는 컴포넌트를 지우거나 블러 처리하는 Chrome extension (Manifest V3).

## 원리

1. 하루의 첫 방문 때 content script가 페이지 컴포넌트 후보를 모은다: 사이트별로 직접 고른 seed selector, 그리고 `aria-label`이 붙은 영역(landmark)을 자동으로 찾은 것.
2. background service worker가 [Jev](https://docs.typesafe.ai/introduction)(TypeSafe의 System One 모델)에 사이트당 요청 한 번을 보낸다. state는 `user_goal`과 `components[]`이고, 컴포넌트마다 Noul 질문 두 개를 묻는다: `distracting`과 `essential`.
3. 판정 규칙은 프롬프트가 아니라 코드(`src/decide.ts`)에 있다: essential ≥ 0.5이면 keep, distracting ≥ 0.8이면 hide, ≥ 0.5이면 blur.
4. 결과는 `chrome.storage.local`에 날짜와 함께 CSS로 굳혀 둔다. 그날 하루는 모델을 다시 부르지 않고 같은 CSS만 `document_start`에 주입한다. 그래서 렌더링이 결정적이다.

## 개발

```bash
bun install
bun run build      # dist/
bun test
bun run typecheck
```

`chrome://extensions`에서 개발자 모드를 켜고 `dist/`를 "압축해제된 확장 프로그램 로드"로 연다. 툴바 아이콘을 누르면 설정 페이지가 열린다. 거기에 [TypeSafe API key](https://console.typesafe.ai/keys)와 사이트별 목표를 넣는다.

## 주의

- seed selector는 2026년 기준 마크업 추정치다. 사이트가 바뀌면 깨지니 DevTools로 확인하며 `src/sites.ts`를 고친다.
- 요청에 컴포넌트의 보이는 텍스트 앞 160자가 함께 간다. 피드 내용 일부가 TypeSafe로 전송된다는 뜻이다.
- API key는 `chrome.storage.local`에 평문으로 저장된다. 개인용 전제다.

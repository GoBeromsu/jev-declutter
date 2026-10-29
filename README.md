# Jev Declutter

YouTube, X, Instagram, LinkedIn 피드에서 광고(스폰서·프로모션), 팔로우하지 않은 계정의 추천 아이템, 추천 모듈(Shorts·Reels·트렌드·알 수도 있는 사람·LinkedIn News 등)을 지우거나 블러 처리하는 개인용 Chrome extension (Manifest V3).

## 목적

피드를 지우지 않고도 읽고 싶은 것만 남긴다. 사이트의 상태(팔로우 관계, 저장 목록, 재생 기록)는 건드리지 않는다: 화면에서 보이지 않게 하는 것까지가 범위다.

## 동작 방식

1. **결정적 신호 먼저.** `document_start`에서 content script가 피드 아이템을 하나씩 본다. 구조(광고 속성, follow 버튼, 외부 링크, 미디어 종류)와 UI 라벨(`Sponsored`/`광고`, `Suggested`/`추천`, `Follow`/`팔로우`)만으로 판단되는 아이템은 모델을 부르지 않고 바로 처리한다.
2. **하루짜리 신호 캐시.** 결정적 신호로 판단되지 않는 아이템은 구조 시그니처(`사이트:해시`) + 신호 조합으로 키를 만든다. 그날 이미 판정한 키는 `chrome.storage.local` 캐시에서 꺼내 쓴다. provider·모델·질문 버전이 바뀌면 캐시는 비워진다(사이트당 최대 2000개, 오래된 것부터 제거).
3. **배치 모델 호출.** 처음 보는 아이템만 120 ms 동안 모아 요청 하나로 묶는다(요청당 최대 20개, 하루 300회, 분당 30회). 응답이 오면 그 판정도 같은 캐시에 저장한다.
4. **보이지 않는 배치 규칙.** 판정(hide/blur/keep)은 화면에 보이지 않는 이동을 일으키지 않도록 위치에 따라 적용된다. 아직 아무것도 그려지지 않은 첫 프레임, 또는 뷰포트 아래에 있는 아이템은 `hide`, 이미 그려진 화면 안이나 위쪽에 있는 아이템은 `blur`(레이아웃을 바꾸지 않음). 그래서 화면이 밀리거나 깜빡이지 않고, 늦게 도착한 판정도 이미 보이는 아이템을 블러로만 바꾼다. 추천 모듈도 content script가 같은 규칙으로 처리한다(manifest에 `css`를 넣지 않는 이유).

실패는 모두 열린 채로 끝난다(fail open): 키가 없거나, HTTP 오류·429·거부(refusal)·예산 소진·오프라인이면 그 아이템은 `keep`이고 결정적 규칙만 계속 동작한다.

## Provider와 비용

| Provider | 엔드포인트 | 기본 모델 | 입력 가격 | 쓸 때 |
| --- | --- | --- | --- | --- |
| OpenAI Decisions (기본) | `https://api.openai.com/v1/decisions` | `gpt-6-luna` | $0.10 / 1M 토큰 (출력 무료) | 기본값 그대로 |
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | $0.042 / 1M 토큰 | Jev로 바꾸고 싶을 때 |

설정 페이지에서 provider, 각 provider의 API key와 모델, 사이트별 사용 여부, 카테고리별 동작(`hide` / `blur` / `keep`)을 고른다.

**하루 비용 상한.** 실측: 20개 아이템 요청 1회 ≈ 3,040 토큰(한국어 fixture, 실제 어댑터와 승인된 설정). 하루 300회면 ≈ 0.9M 토큰 → OpenAI 약 **$0.09/일**, Jev 약 **$0.04/일**. 대부분의 피드는 이미 캐시된 패턴이라 실제 사용량은 보통 이보다 훨씬 적다.

## 개인정보

- API로 나가는 것은 **구조와 UI 라벨뿐**이다: 사이트, 시그니처, 라벨 슬롯의 짧은 문자열(최대 40자), follow 버튼·외부 링크·광고 속성·미디어 종류. **게시물 본문, 작성자 이름, 댓글, 이미지 픽셀은 보내지 않는다.** 본문 안에 있는 요소의 텍스트는 라벨로 읽지 않는다.
- DM/메시지 페이지는 스캔하지 않는다: X `/messages`, `/i/chat`, Instagram `/direct`, LinkedIn `/messaging`.
- API key는 `chrome.storage.local`에 **평문**으로 저장된다. 개인 프로필 전제이고, 브라우저 프로필에 접근할 수 있는 사람은 키를 읽을 수 있다.
- 이 extension이 요청하는 것: `storage` 권한과 `api.openai.com`·`api.typesafe.ai` 두 host. 네트워크를 막는 권한(`declarativeNetRequest`, `webRequest`), `scripting`, `tabs` 권한은 쓰지 않는다. 원격 에셋도 없다.

## Aside에 설치하기 (한 번만)

Aside는 Chromium 포크다. 확장 프로그램은 `aside://extensions`(= `chrome://extensions/`)에서 압축 해제된(load unpacked) 형태로 넣는다. Developer mode와 "Load unpacked" 버튼은 존재하지만, 폴더 선택은 macOS 기본 패널이라 자동화할 수 없다 — 아래 클릭 몇 번은 직접 한다.

1. 메인 체크아웃에서 빌드해 `dist/`를 만든다:
   ```bash
   cd /Users/beomsu/Projects/jev-declutter
   bun install && bun run build
   ```
2. Aside에서 `aside://extensions`를 연다.
3. 상단 배너의 **Developer mode** 스위치를 켠다. "Load unpacked / Pack extension / Update" 버튼이 나타난다.
4. **Load unpacked**를 누르고 열린 패널에서 `/Users/beomsu/Projects/jev-declutter/dist` 를 선택한다.
   메인 체크아웃 경로를 한 번만 등록하면, 이후 재빌드 때는 카드의 새로고침(↻) 버튼만 누르면 된다.
5. 새 카드에 표시되는 확장 ID(`ID: ...`)를 기록한다. 설정 페이지는 `chrome-extension://<ID>/options.html` 이고, 퍼즐 조각 메뉴에서 고정해 둘 수 있다.
6. 설정 페이지에서 provider를 고르고 API key를 넣는다. 그다음 YouTube / X / Instagram / LinkedIn 피드를 열어 확인한다.

## 개발

```bash
bun install
bun run build        # dist/ (IIFE 번들 3개 + public/ 복사)
bun test             # 단위·fixture 테스트 (happy-dom)
bun run typecheck    # tsc --noEmit
bun run qa           # fixture 스크롤 QA (headless Chrome): 시프트·플래시·메인스레드 시간 측정
```

- `src/sites.ts`의 selector는 2026년 마크업 증거(uBlock uAssets/EasyList, 유지되는 extension들)에 기반한다. 사이트가 바뀌면 `tests/fixtures/<site>-<lang>.html`로 재현하고 selector와 fixture를 함께 고친다.
- 마커 단어와 임계값은 `src/markers.ts`, `src/decide.ts`에 있다. 설정 페이지에서 오늘의 판정 표와 예산 사용량을 볼 수 있고, 캐시를 비울 수 있다(설정 변경과 캐시 초기화는 다음 페이지 이동부터 적용).

# Jev Declutter

YouTube, X, Instagram, LinkedIn 피드에서 광고와 플랫폼 추천(팔로우하지 않은 계정의 게시물, Shorts·Reels·트렌드·알 수도 있는 사람·LinkedIn News 같은 모듈)을 걸러내는 개인용 Chrome extension (Manifest V3).

## 목적

피드를 지우지 않고도 읽고 싶은 것만 남긴다. 아이템은 누가 넣었는지로 나뉜다: 내가 팔로우한 것(그대로), 광고(스위치로 숨김, 기본 켬), 플랫폼 추천(스위치로 숨김, 기본 켬). 재배치·큐레이션은 하지 않는다 — 사이트가 이미 마크업에 남긴 신호(광고 속성, `Sponsored`/`추천` 라벨, follow 버튼)로 거르기만 한다. 사이트의 상태(팔로우 관계, 저장 목록, 재생 기록)는 건드리지 않는다: 화면에서 보이지 않게 하는 것까지가 범위다.

## 동작 방식

1. **결정적 신호 먼저.** `document_start`에서 content script가 피드 아이템을 하나씩 본다. 구조(광고 속성, follow 버튼, 외부 링크, 미디어 종류)와 UI 라벨(`Sponsored`/`광고`, `Suggested`/`추천`, `Follow`/`팔로우`)만으로 판단되는 아이템은 모델을 부르지 않고 바로 처리한다.
2. **하루짜리 신호 캐시.** 결정적 신호로 판단되지 않는 아이템은 구조 시그니처(`사이트:해시`) + 신호 조합으로 키를 만든다. 그날 이미 판정한 키는 `chrome.storage.local` 캐시에서 꺼내 쓴다. provider·모델·질문 버전이 바뀌면 캐시는 비워진다(사이트당 최대 2000개, 오래된 것부터 제거).
3. **배치 모델 호출.** 처음 보는 아이템만 120 ms 동안 모아 요청 하나로 묶는다(요청당 최대 20개, 하루 300회, 분당 30회). 응답이 오면 그 판정도 같은 캐시에 저장한다.
4. **숨김은 사라짐.** `hide`는 위치와 상관없이 아이템을 페이지에서 없앤다(`display:none`). `blur`는 설정이 아니라 "확실하지 않음" 상태다: 모델 판정이 이미 그려진 화면 안에 걸리면 숨기지 않고 블러 위에 예/아니오를 묻는다. "예"면 사라지고, "아니오"면 원래대로 돌아온다. 결정적 신호로 판정된 아이템과 추천 모듈은 묻지 않고 바로 사라진다. 추천 모듈도 content script가 같은 규칙으로 처리한다(manifest에 `css`를 넣지 않는 이유).

실패는 모두 열린 채로 끝난다(fail open): 키가 없거나, HTTP 오류·429·거부(refusal)·예산 소진·오프라인이면 그 아이템은 `keep`이고 결정적 규칙만 계속 동작한다.

## Provider와 비용

| Provider | 엔드포인트 | 기본 모델 | 입력 가격 | 쓸 때 |
| --- | --- | --- | --- | --- |
| OpenAI Decisions (기본) | `https://api.openai.com/v1/decisions` | `gpt-6-luna` | $0.10 / 1M 토큰 (출력 무료) | 기본값 그대로 |
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | $0.042 / 1M 토큰 | Jev로 바꾸고 싶을 때 |

설정 페이지에서 모델(드롭다운 하나가 provider까지 정한다)과 그 provider의 API key, 사이트(아이콘 체크), 광고·추천 숨김 스위치를 고른다.

**하루 비용 상한.** 실측: 20개 아이템 요청 1회 ≈ 3,040 토큰(한국어 fixture, 실제 어댑터와 승인된 설정). 하루 300회면 ≈ 0.9M 토큰 → OpenAI 약 **$0.09/일**, Jev 약 **$0.04/일**. 대부분의 피드는 이미 캐시된 패턴이라 실제 사용량은 보통 이보다 훨씬 적다.

## 개인정보

- API로 나가는 것은 **구조와 UI 라벨뿐**이다: 사이트, 시그니처, 라벨 슬롯의 짧은 문자열(최대 40자), follow 버튼·외부 링크·광고 속성·미디어 종류. **게시물 본문, 작성자 이름, 댓글, 이미지 픽셀은 보내지 않는다.** 본문 안에 있는 요소의 텍스트는 라벨로 읽지 않는다.
- DM/메시지 페이지는 스캔하지 않는다: X `/messages`, `/i/chat`, Instagram `/direct`, LinkedIn `/messaging`.
- API key는 `chrome.storage.local`에 **평문**으로 저장된다. 개인 프로필 전제이고, 브라우저 프로필에 접근할 수 있는 사람은 키를 읽을 수 있다.
- 이 extension이 요청하는 것: `storage` 권한과 `api.openai.com`·`api.typesafe.ai` 두 host. 네트워크를 막는 권한(`declarativeNetRequest`, `webRequest`), `scripting`, `tabs` 권한은 쓰지 않는다. 원격 에셋도 없다.

## Aside에 설치하기 (한 번만)

Aside는 Chromium 포크다. 확장 프로그램은 `aside://extensions`(= `chrome://extensions/`)에서 압축 해제된(load unpacked) 형태로 넣는다. Developer mode와 "Load unpacked" 버튼은 존재하지만, 폴더 선택은 macOS 기본 패널이라 자동화할 수 없다 — 아래 클릭 몇 번은 직접 한다.

1. 메인 체크아웃에서 빌드해 `.output/chrome-mv3/`를 만든다(개발할 때는 Aside 대신 `bun run dev`가 띄우는 Chrome을 쓴다 — 아래 "개발"):
   ```bash
   cd /Users/beomsu/Projects/jev-declutter
   bun install && bun run build
   ```
2. Aside에서 `aside://extensions`를 연다.
3. 상단 배너의 **Developer mode** 스위치를 켠다. "Load unpacked / Pack extension / Update" 버튼이 나타난다.
4. **Load unpacked**를 누르고 열린 패널에서 `/Users/beomsu/Projects/jev-declutter/.output/chrome-mv3`를 선택한다.
   경로를 한 번만 등록하면, 이후 `bun run build` 때는 카드의 새로고침(↻) 버튼만 누르면 된다.
5. 새 카드에 표시되는 확장 ID(`ID: ...`)를 기록한다. 설정 페이지는 `chrome-extension://<ID>/options.html` 이고, 퍼즐 조각 메뉴에서 고정해 둘 수 있다.
6. 설정 페이지에서 provider를 고르고 API key를 넣는다. 그다음 YouTube / X / Instagram / LinkedIn 피드를 열어 확인한다.

## 개발

빌드는 [WXT](https://wxt.dev)가 한다. 진입점은 `entrypoints/`(background·content·options)에 얇게 있고, 로직은 전부 `src/`에 있다. manifest는 `wxt.config.ts`에서 만든다. 개발 빌드는 hot reload를 위해 `tabs`·`scripting` 권한을 더하지만, 배포 빌드에는 들어가지 않는다(`tests/manifest.test.ts`가 실제 `wxt build` 결과로 확인).

```bash
bun install
bun run dev          # WXT 개발 서버: 개발 빌드가 로드된 Chrome을 직접 띄우고 저장할 때마다 hot reload
                     #   (설정 페이지는 Vite HMR, background/content 는 확장 재시작 + 열린 피드 탭 새로고침)
                     #   프로필은 .wxt/chrome-profile 에 남는다: API key·Instagram 로그인은 처음 한 번만
bun run build        # WXT 배포 빌드: .output/chrome-mv3
bun test             # 단위·fixture 테스트 (happy-dom)
bun run typecheck    # tsc --noEmit
bun run qa           # fixture 스크롤 QA (headless Chrome): 시프트·플래시·메인스레드 시간 측정
```

- `src/sites.ts`의 selector는 2026년 마크업 증거(uBlock uAssets/EasyList, 유지되는 extension들)에 기반한다. 사이트가 바뀌면 `tests/fixtures/<site>-<lang>.html`로 재현하고 selector와 fixture를 함께 고친다.
- 마커 단어와 임계값은 `src/markers.ts`, `src/decide.ts`에 있다. 설정 페이지에서 오늘의 판정 표와 예산 사용량을 볼 수 있고, 캐시를 비울 수 있다(설정 변경과 캐시 초기화는 다음 페이지 이동부터 적용).

## 유지보수: LinkedIn React 마크업 드리프트 확인

LinkedIn React 피드의 광고 판정은 label slot 하나(`h2 + div p[componentkey]`)에 걸려 있다. 이 selector가 깨지면 광고가 다시 보이기만 하고(fail open) 경고는 아무 데도 남지 않는다. 그 침묵을 깨는 명령이다:

```bash
bun run scripts/probe/linkedin.ts
```

Aside 브라우저에 자기 탭을 열어 `https://www.linkedin.com/feed/`를 스크롤하고, 세고, 숫자만 출력한 뒤 탭을 닫는다. 읽기 전용이다: 클릭·입력·저장·네트워크 요청이 없고, extension이 로드되어 있지 않아도 된다(`src/sites.ts`의 설정과 `extractSignals`를 페이지에서 그대로 다시 돌린다). 출력은 숫자와 불린뿐이고, **게시물 본문·이름·URL·식별자는 출력하거나 저장하지 않는다**.

| 필드 | 뜻 |
| --- | --- |
| `itemsSeen` | item selector가 잡은 아이템 수 |
| `adMarkerItems` / `adDetected` | 헤더에 `Sponsored`/`광고` 같은 마커가 **정확히** 일치하는 아이템 수 / 그중 현재 설정이 광고로 판정한 수 |
| `suggestedMarkerItems` / `suggestedDetected` | `Suggested`/`추천` 마커 기준의 같은 쌍 (라이브에서 아직 0건이라 0 of 0이 정상) |
| `organicFalseMarked` | 마커가 없는데 판정이 붙은 아이템 수 — 0이어야 한다 |
| `maxChromeLen` | `chrome_text` 문자열의 최대 길이. 본문 유출 감지용 카나리아(상한 40) |

`adDetected < adMarkerItems`면 label slot이 깨진 것이고, `organicFalseMarked > 0`이면 일반 글에 판정이 붙은 것이다. 둘 중 하나라도 걸리거나 아이템을 하나도 못 보면 종료 코드 1(`checks` 필드에 어느 쪽인지 나온다). 마커 기준은 `labelSlots`과 **독립적으로** 계산한다(본문 영역 밖 헤더의 짧은 텍스트 노드를 직접 훑는다). 그래서 slot이 사라지면 마커는 그대로 보이고 판정만 빠져 미검출로 드러난다 — 이 실패 제어는 `tests/probe.test.ts`가 고정한다.

숫자가 어긋나면 `src/sites.ts`의 LinkedIn selector와 `tests/fixtures/linkedin-react-*.html`을 같이 고친다. 규칙과 한계(본문 아래로 옮겨간 마커, 구조 기반 광고 속성)는 `scripts/probe/linkedin-count.ts` 주석에 적혀 있다.

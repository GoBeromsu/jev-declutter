# AGENTS.md

## 확인 순서

저장소 루트에서 아래 순서대로 직접 실행한다. package.json 스크립트로 감싸지 않는다.

1. `bunx oxlint`: 실패하면 코드에 주석이 있거나 Oxlint 규칙(`perf` 포함)에 걸린 패턴이 있다. `perf`는 느려지기 쉬운 코드 모양을 짚을 뿐, 속도를 재지는 않는다.
2. `bun run typecheck`: 실패하면 타입 오류다.
3. `bun test`: 실패하면 동작이 깨졌거나 어딘가에 주석이 남아 있다.
4. `bunx wxt build`: 실패하면 extension을 빌드할 수 없다.
5. `bunx size-limit`: 실패하면 번들이 예산(package.json의 `size-limit`)을 넘었다. 4번 빌드 결과를 잰다.

## 주석 금지

TS/JS에는 주석을 쓰지 않는다. `oxlint-disable`, `eslint-disable`, `@ts-*` 같은 지시문도 주석이라 금지다. 의도는 식별자 이름과 `test("...")` 이름에 담는다. 규칙 예외가 꼭 필요하면 `.oxlintrc.json`의 `overrides`에 glob으로 건다.

`bun test`도 이 규칙을 지킨다(`tests/no-comments.test.ts`가 oxc-parser로 주석 수를 센다). oxlint 1.91.0에서는 `*-disable-line` 지시문과 파일 맨 앞의 `/* oxlint-disable */`, `/* eslint-disable */`가 자기 자신을 포함해 규칙을 꺼 버려서, oxlint만으로는 그런 주석을 못 잡는다.

## 수동 성능 확인

남은 런타임 확인은 이것 하나다. `.output/chrome-mv3`를 압축 해제 상태로 로드하거나 `bun run dev`로 띄운다. DevTools Performance에서 피드를 10초 스크롤하며 기록하고, extension을 켠 상태와 끈 상태를 한 번씩 비교한다. 통과 조건은 두 가지다. Layout Shifts 트랙이 비어 있고, content script 때문에 생긴 50 ms 넘는 long task가 없다.

## 번들 예산

`size-limit`의 limit을 올리려면 커밋 메시지에 이유를 적는다.

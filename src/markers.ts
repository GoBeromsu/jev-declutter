export const AD_WORDS: string[] = ["Sponsored", "Promoted", "Ad", "광고", "프로모션", "Promoted by LinkedIn"];

export const SUGGESTED_WORDS: string[] = [
  "Suggested",
  "Suggested for you",
  "Suggested post",
  "추천",
  "회원님을 위한 추천",
  "추천 게시물"
];

export const FOLLOW_WORDS: string[] = ["Follow", "팔로우", "+ Follow", "팔로우하기"];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function matchesWord(text: string, words: string[]): boolean {
  const t = normalize(text);
  if (t === "") return false;
  return words.some((w) => normalize(w) === t);
}

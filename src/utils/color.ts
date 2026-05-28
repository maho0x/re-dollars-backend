const palette = [
  '#d24b4b',
  '#c06c30',
  '#8a7a18',
  '#34966f',
  '#2d8a91',
  '#4777bc',
  '#7b5bb8',
  '#b04f8b',
];

export function generateUserColor(uid: number) {
  const index = Math.abs(Number(uid) || 0) % palette.length;
  return palette[index] ?? '#4777bc';
}

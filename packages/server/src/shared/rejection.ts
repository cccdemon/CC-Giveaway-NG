export interface Rejection {
  rejected: true;
  code: string;
  message: string;
}

export function reject(code: string, message: string): Rejection {
  return { rejected: true, code, message };
}

export function isRejection(x: unknown): x is Rejection {
  return typeof x === 'object' && x !== null && (x as { rejected?: unknown }).rejected === true;
}

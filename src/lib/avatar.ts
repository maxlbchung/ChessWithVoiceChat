import { get, set, del } from 'idb-keyval';

const AVATAR_KEY = 'chess.avatar.v1';
const MAX_DIM = 256;
const QUALITY = 0.85;

export async function loadAvatar(): Promise<string | null> {
  return (await get<string>(AVATAR_KEY)) ?? null;
}

export async function saveAvatar(dataUrl: string): Promise<void> {
  await set(AVATAR_KEY, dataUrl);
}

export async function clearAvatar(): Promise<void> {
  await del(AVATAR_KEY);
}

// Resize an image File/Blob and return a JPEG data URL capped at MAX_DIM on the
// longer side. Keeps avatars small enough to ship cheaply over the data channel.
export async function fileToAvatarDataUrl(file: Blob): Promise<string> {
  const img = await loadImage(file);
  const ratio = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', QUALITY);
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('failed to decode image'));
    };
    img.src = url;
  });
}

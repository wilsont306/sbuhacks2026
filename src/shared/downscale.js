// Shrinks a picture in the browser before upload: longest side 1024 px, JPEG quality 0.8 (about 150 to 400 KB), so it
// fits the 1.5 MB cap of /api/interpret and Vercel's 4.5 MB body cap. Shared by the TV (drop, U) and the phone camera.
// No ES2020 syntax: the phone page must parse on iOS 13. An <img> applies EXIF orientation before the canvas draw.
export function downscale(file, opts) {
  const max = (opts && opts.max) || 1024, quality = (opts && opts.quality) || 0.8;
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', quality);
      resolve({ base64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl: dataUrl, width: c.width, height: c.height });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}

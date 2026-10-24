# Depth export for the host relief (README "Depth map"): Depth Anything V2 Small (Apache-2.0) on the scan,
# written as a 16-bit value packed into an 8-bit RGB PNG (R = high byte, G = low byte, B = 0), nearest = 65535.
#   pip install torch transformers pillow numpy
#   python tools/depth.py [--in public/assets/turner-1920.jpg] [--out public/depth/turner-depth.png] [--size 2048] [--blur 2.5]
import argparse
import os

import numpy as np
from PIL import Image

MODEL = 'depth-anything/Depth-Anything-V2-Small-hf'


def gaussian(d, sigma):
    # Separable blur in numpy: Pillow's GaussianBlur does not take float ('F') images.
    if sigma <= 0:
        return d
    r = max(1, int(3 * sigma + 0.5))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    for ax in (0, 1):
        p = np.pad(d, [(r, r) if i == ax else (0, 0) for i in (0, 1)], mode='edge')
        d = np.apply_along_axis(np.convolve, ax, p, k, 'valid')
    return d


def pack(near):
    # near: float array in 0..1 (1 = nearest) -> uint16 values and the HxWx3 uint8 RG image.
    v = np.round(np.clip(near, 0, 1) * 65535).astype(np.uint16)
    return v, np.dstack([v >> 8, v & 255, np.zeros_like(v)]).astype(np.uint8)


def write_png(path, rgb, v):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    Image.fromarray(rgb).save(path)  # a fresh image carries no info, so Pillow writes no gAMA/iCCP/sRGB
    back = Image.open(path)
    assert not {'gamma', 'srgb', 'icc_profile'} & back.info.keys(), 'colour chunk in ' + path
    b = np.asarray(back.convert('RGB')).astype(np.uint16)
    assert ((b[..., 0] << 8) | b[..., 1]).tolist() == v.tolist(), 'packed values did not round-trip'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', default='public/assets/turner-1920.jpg')
    ap.add_argument('--out', default='public/depth/turner-depth.png')
    ap.add_argument('--size', type=int, default=2048, help='long edge of the scan fed to the model (downscale only)')
    ap.add_argument('--blur', type=float, default=2.5, help='Gaussian sigma in output pixels, applied before packing')
    a = ap.parse_args()

    from transformers import pipeline  # imported late so --help and the helpers work without torch

    img = Image.open(a.src).convert('RGB')
    W, H = img.size
    scan = img.copy()
    scan.thumbnail((a.size, a.size), Image.LANCZOS)
    pred = pipeline('depth-estimation', model=MODEL)(scan)['predicted_depth']
    raw = pred.squeeze().float().cpu().numpy()  # relative inverse depth: larger = nearer, so no flip
    print(f'model output {raw.shape[1]}x{raw.shape[0]}  min {raw.min():.4f}  max {raw.max():.4f}')

    d = np.asarray(Image.fromarray(raw.astype(np.float32)).resize((W, H), Image.BILINEAR), dtype=np.float64)
    d = gaussian(d, a.blur)
    d = (d - d.min()) / (d.max() - d.min())  # normalised last so the blur cannot pull nearest below 65535
    v, rgb = pack(d)
    write_png(a.out, rgb, v)
    print(f'wrote {a.out} {W}x{H}  packed min {v.min()}  max {v.max()}')

    bottom, top = d[-H // 10:].mean(), d[:H // 10].mean()
    ok = 'OK, bank nearer than sky' if bottom > top else 'CHECK SIGN: bottom is not nearer than top'
    print(f'sign: bottom tenth {bottom:.3f} vs top tenth {top:.3f} -> {ok}')


if __name__ == '__main__':
    main()

# Spectrum Image Format v4

This spec defines the spectrum images that atools writes and reads. An implementation needs only PNG codec, FFT, and JSON support. The ticket recovers parameters after a platform transcodes the image; a standard PNG round trip does not depend on it.

## 1. Data Model

The encoder turns mono PCM into `frames × bins` STFT cells. The array is in frame-major order:

```text
i = frame * bins + bin
frame = 0 .. frames - 1
bin   = 0 .. bins - 1       # 0 is DC, frequency is bin * sr / win
```

| Mode | Metadata | Image | Audio restoration |
| --- | --- | --- | --- |
| Compact | `exact=0`, `bits=2/4/8` | One quantized magnitude spectrum | Phase is not unique; the decoder estimates it |
| Exact | `exact=1`, `bits=0` | Magnitude and phase spectra | The original PNG goes straight to inverse STFT |

Integer rounding in this spec uses `round(x) = floor(x + 0.5)`. Values are clamped to `0..255` before byte writes.

## 2. STFT Conventions

Let the input be `pcm[0..samples-1]`, the window length `N=win`, and the hop `H=hop`.

1. Pad both ends of the PCM with `N/2` zeros each to get `xpad`.
2. Take the periodic Hann window:

   ```text
   w[m] = 0.5 - 0.5*cos(2*pi*m/N), m = 0..N-1
   ```

3. The frame count is `floor(max(1, samples)/H)+1`.
4. The DFT of frame `f` is:

   ```text
   X[f,k] = sum(xpad[f*H+m] * w[m] * exp(-j*2*pi*k*m/N), m=0..N-1)
   ```

5. The image stores `k=0..bins-1`. The full one-sided spectrum uses `bins=N/2+1`; a smaller `bins` is allowed when high frequencies are cut off.

The reference magnitude is `scale=N/4`. dB values are computed as `20*log10(abs(X)/scale)`.

## 3. PNG and Metadata

The encoder writes a standard PNG and adds one `tEXt` chunk:

```text
keyword: spectrum
text:    [4,sr,win,hop,frames,bins,samples,bits,ref,exact]
```

The keyword and the JSON contain only ASCII bytes. PNG chunks use standard CRC-32. The reader validates the PNG signature, chunk boundaries, CRC, IHDR, and IEND.

| Position | Field | Constraint |
| ---: | --- | --- |
| 0 | version | Must be `4` |
| 1 | sr | Integer, `1..96000` Hz |
| 2 | win | `256/512/1024/2048/4096` |
| 3 | hop | Integer, `1..win`; this project writes `win/4` |
| 4 | frames | Integer, `1..min(65535, floor(16000000/(bins*bands)))` |
| 5 | bins | Integer, `2..win/2+1` |
| 6 | samples | Integer, `0..min(8000000, (frames-1)*hop+win)` |
| 7 | bits | `0/2/4/8`; a spec writer picks by mode |
| 8 | ref | Finite dB value; rounded to 0.1 dB when written to JSON |
| 9 | exact | `0/1` |

`bands` is 1 in Compact mode and 2 in Exact mode. Implementations may append fields at the end of the array; a v4 reader ignores values after entry 10. Changing existing fields, pixel coordinates, or value mappings requires a new version number.

The file name may carry one fallback copy of the parameters:

```text
{stem}_SR{sr}_N{win}_H{hop}_F{frames}_L{samples}_B{bits}.png
```

The file name does not store `bins` or `ref`. When a valid `tEXt` is missing, atools uses `bins=win/2+1`, `ref=0`, `exact=(bits==0)`.

## 4. Color Ramp

Magnitude pixels use a 256-level RGB ramp. The G channel equals the level. The encoder interpolates linearly per channel between adjacent control points and rounds:

```text
(level, R, B)
(0,     0,   0)
(24,    34,  6)
(64,    110, 22)
(112,   190, 52)
(168,   232, 120)
(216,   250, 190)
(255,   255, 255)
```

For control points `(la,ra,ba)` and `(lb,rb,bb)` with `la <= level <= lb`:

```text
t = (level-la)/(lb-la)
R = round(ra + (rb-ra)*t)
G = level
B = round(ba + (bb-ba)*t)
```

When reading magnitude pixels that went through RGB transcoding, atools computes first:

```text
Y = round(0.299*R + 0.587*G + 0.114*B)
level = max(l in 0..255 where luma(ramp[l]) <= Y)
```

Standard ramp pixels recover their original level.

## 5. Compact Image

### 5.1 Magnitude Quantization

Let `steps=2^bits-1` and the dynamic range `span=12*bits` dB. The reference encoder sets `stride=max(1,floor(frames/240))`, checks the frames at `f=0,stride,2*stride...`, and takes:

```text
ref = peak > 0 ? 20*log10(peak/scale)+1 : 0
floorDb = ref-span
q = clamp(round((db-floorDb)/span*steps), 0, steps)
level = round(q*255/steps)
```

A third-party encoder may derive the peak from all frames. Interoperability only requires `ref` and the pixels to share one reference.

### 5.2 PNG Layout

A Compact image uses an indexed-color PNG, `frames` wide and `bins` tall in effective height. The bit depth equals `bits`. The palette has `2^bits` entries, and entry `q` is `ramp[round(q*255/steps)]`.

```text
x = frame
y = bins - 1 - bin
palette_index = q
```

The top of the image is the highest frequency bin and the bottom is DC. The encoder may append 8 ticket rows below the effective image; the IHDR height grows accordingly.

### 5.3 Decoding

After a pixel yields `level`:

```text
q = round(level*steps/255)
db = ref-span + q/steps*span
magnitude = exp(db*ln(10)/20) * (win/4)
```

A Compact image has no phase. Zero phase plus inverse STFT produces valid output; PGHI, Griffin-Lim, or RTISI improves how it sounds. Different algorithms produce different waveforms, which does not affect format compatibility.

## 6. Exact Image

An Exact image uses an RGBA PNG, `frames` wide and `2*bins` tall in effective height. The first `bins` rows store magnitude, the last `bins` rows store phase.

### 6.1 Magnitude Section

```text
db = 20*log10(abs(X)/(win/4))
level = clamp(round((db+120)/120*255), 0, 255)
x = frame
y = bins - 1 - bin
RGBA = (ramp[level].R, level, ramp[level].B, 255)
```

Zero magnitude writes `level=0`.

### 6.2 Phase Section

For `X = re+j*im` with `mag=abs(X)`:

```text
if mag > 0:
    C = round((re/mag*0.5+0.5)*255)
    S = round((im/mag*0.5+0.5)*255)
else:
    C = 255
    S = 128

x = frame
y = bins + (bins - 1 - bin)
RGBA = (C, S, 0, 255)
```

The encoder may append 8 ticket rows below the phase section.

### 6.3 Direct Inverse Transform

After reading `level/C/S`:

```text
db = -120 + level/255*120
mag = exp(db*ln(10)/20) * (win/4)
cr = (C-127.5)/127.5
cs = (S-127.5)/127.5
h = sqrt(cr*cr+cs*cs)
phase_vector = h > 0.1 ? (cr/h, cs/h) : previous_vector_for_this_bin
X = mag * phase_vector
```

The initial previous vector is `(1,0)`. Set the high-frequency bins that were not stored to zero and run a standard real IFFT. Multiply every frame by the same Hann window, then overlap-add at `f*hop`. Divide each sample by `sum(w²)` at the overlap, and take `samples` samples starting at offset `win/2`. This flow matches the atools direct restoration path.

## 7. Parameter Ticket

The ticket recovers parameters after a platform strips the tEXt and the file name. The encoder may omit the ticket; an original PNG with a valid tEXt does not depend on it.

The atools ticket supports width `2..65535`, window lengths `256/512/1024/2048`, and the sample rates below:

```text
index: 0     1      2      3      4      5      6      7      8
sr:    8000  11025  12000  16000  22050  24000  32000  44100  48000

index: 9      10     11     12      13
sr:    64000  88200  96000  176400  192000
```

Window length indices are `0:256, 1:512, 2:1024, 3:2048`. The width field picks 8, 12, or 16 bit by value; the matching prefixes are `00`, `01`, `10`.

The bitstream is MSB first:

```text
sync 4          1010
magic 4         1011
width prefix 2  00/01/10
width           8/12/16 bit
sr index 4
win index 2
exact 1
crc 8
```

The CRC covers `magic` through `exact` and does not cover `sync`. The algorithm runs the steps below bit by bit; do not pack the bitstream into bytes first:

```text
crc = 0xFF
for bit in covered_bits:
    crc = crc XOR (bit << 7)
    repeat 8 times:
        crc = ((crc << 1) XOR 0x07) & 0xFF  if crc & 0x80
              (crc << 1) & 0xFF             otherwise
```

The ticket occupies the bottom 8 rows, with one value written across every row of a column. Exact images use gray RGBA: dark value 20, light value 230, alpha 255. Compact images use the first and last palette entries. The column width per bit is:

```text
image width >= 160: 4 px
image width >= 70:  2 px
otherwise:          1 px
```

`bit_count=25+width_bits`, and one copy spans `span=2+bit_count*bit_width`. The left copy starts at `base=2`; `base..base+1` is the dark anchor, and bit `j` is written in the columns starting at `base+2+j*bit_width`. The remaining columns stay dark. When the image width satisfies `width >= 2*span+6`, the encoder writes another copy at `base=width-span`. When the width is below `span+2` or below 46, the ticket is omitted.

The decoder averages the bottom 2 to 8 rows per column and binarizes with `(min+max)/2`. It estimates the scale unit from the four equal-width alternating runs of `1010`, then expands them and validates the magic, field lengths, and CRC.

## 8. atools Read Order

1. Read and validate the PNG `spectrum` tEXt.
2. If the tEXt is invalid, parse the file name.
3. If parameters are still missing, inspect the indexed palette and the ticket.
4. Check for the Exact pixel signature; if it is not recognized, treat the whole image as a magnitude spectrum.

When an image was rescaled, atools averages the pixels covered by each target cell. It judges whether the phase is still usable from the mean phase vector length: the threshold is 0.3 for a full-size JPEG and 0.5 for a rescaled image; when at least 60% of the width survives and reliability reaches 0.15, the phase serves only as a reconstruction anchor.

Exact pixel detection samples the upper and lower sections separately. At least 55% of the upper pixels must match the ramp within a tolerance of 32 per channel; at least 55% of the lower pixels must satisfy `B<=48` with the radius of `(R-127.5, G-127.5)` in `96..160`. The reader also requires at least 12 phase samples to hit.

On success, the reader sets `raw=2*(rows-1)` and picks the largest power of 2 not exceeding `min(raw,4096)`, with a minimum of 256; `hop=win/4` and the sample rate is 8 kHz. An ordinary image uses the same geometry rules, a sample rate of 44.1 kHz, at most 6000 frames, and at most 1025 bins.

## 9. Minimal Interoperable Implementation

To produce an image that atools restores directly, implement Exact first:

1. Compute the STFT as in section 2.
2. Write `frames × 2*bins` RGBA pixels as in section 6.
3. Write the tEXt from section 3. The ticket is optional.
4. Use the section 3 file-name grammar as a tEXt backup.

To restore an atools Exact PNG, read the tEXt and both pixel sections, then follow section 6.3. To restore a Compact PNG, obtain the magnitude as in section 5.3 and pick a phase estimation algorithm.

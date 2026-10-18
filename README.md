# UARTSerialReaderWebsite

A web-based serial monitoring dashboard for the ATmega328P energy monitor, enabling real-time visualisation of voltage, current, power, power factor, and frequency data received over UART.

It runs entirely in the browser — no backend, no build step — and connects to the device over **USB serial** (Web Serial API) or **Bluetooth LE** via an AT-09 module (Web Bluetooth API). A built-in simulator lets you use the dashboard without hardware.

**Live demo:** `https://kishan-harry.github.io/UARTSerialReaderWebsite/?demo` (once GitHub Pages is enabled — see below)

## Features

- Live measurement cards: V<sub>RMS</sub>, I<sub>RMS</sub>, I<sub>peak</sub>, real power, apparent power, power factor, frequency, accumulated energy
- Trend charts with a shared hover cursor and selectable time window (1 / 5 / 15 min / all)
- Reconstructed **idealised** voltage, current and instantaneous-power waveforms, with a combined v/i/p view (see [Waveforms](#reconstructed-waveforms))
- Pause graphs (recording continues), clear, and export the full session to CSV
- Connection status, record/reject counters, stale-data detection, raw-data log
- Responsive layout for phones, tablets and desktop; light and dark themes
- Keeps the phone screen awake while connected (where supported)

## Browser support

| | USB Serial | Bluetooth LE |
|---|---|---|
| Chrome / Edge / Opera — Windows, macOS, Linux, ChromeOS | ✅ | ✅ (Linux may need `chrome://flags/#enable-experimental-web-platform-features`) |
| Chrome on Android | ❌ | ✅ |
| Firefox (any platform) | ❌ | ❌ |
| Safari / any browser on iPhone or iPad | ❌ | ❌ — the third-party **Bluefy** browser adds Web Bluetooth on iOS |

Both APIs require a secure context: **HTTPS** (GitHub Pages) or **`http://localhost`**. The simulator works everywhere.

## Running locally

ES modules don't load from `file://`, so serve the folder:

```sh
python -m http.server 8000
```

Then open <http://localhost:8000> in Chrome or Edge. Add `?demo` to start the simulator automatically.

Protocol tests run in the browser at <http://localhost:8000/tests/>.

## Serial protocol (v1)

One record per line, terminated by `\r\n`, approximately every 1.2 s:

```
EM,1,500.00Hz,14.25V,123.4mA,174.5mA,1.42W,1.75VA,0.81,125.60J
```

| # | Field | Unit | Decimals |
|---|---|---|---|
| 1 | Device identifier `EM` | | |
| 2 | Protocol version `1` | | |
| 3 | Frequency (expected 450–550 Hz) | Hz | 2 |
| 4 | Voltage RMS | V | 2 |
| 5 | Current RMS | mA | 1 |
| 6 | Current peak | mA | 1 |
| 7 | Real power | W | 2 |
| 8 | Apparent power | VA | 2 |
| 9 | Power factor | — | 2 |
| 10 | Accumulated energy | J | 2 |

**Parsing rules** ([js/protocol/em-parser.js](js/protocol/em-parser.js)):

- Incoming data is buffered and split on `\n` by [LineFramer](js/protocol/line-framer.js); `\r` is stripped. A record split across several USB reads or BLE notifications is only parsed once the whole line has arrived.
- A run of more than 256 characters without a terminator is discarded (protects against a wrong baud rate or noise).
- Exactly 10 fields; `EM` and version `1` are required.
- Each field must carry its expected unit suffix — this catches shifted or missing fields — and the number must be a plain decimal (`nan`, `inf`, `1e3`, `12abc` are rejected).
- Rejected lines are counted and shown in the *Raw data* panel with the reason; they never stop the dashboard.
- Plausibility warnings (|PF| > 1, P > S, energy counter decreasing, etc.) flag a record without discarding it.
- **Optional checksum:** a trailing NMEA-style `*HH` (XOR of all characters before `*`, as two hex digits) is verified when present, e.g. `EM,1,…,125.60J*3A`. Recommended for Bluetooth links; records without it are still accepted.

> AVR note: avr-libc's `printf` does not support `%f` by default — use `dtostrf()` to format the values.

## Reconstructed waveforms

The firmware sends summary values, not samples, so the waveform charts show **estimated ideal sinusoids**, recalculated from every complete packet:

- v(t) = √2 · V<sub>RMS</sub> · sin(ωt)
- i(t) = √2 · I<sub>RMS</sub> · sin(ωt − φ), with φ = arccos(PF). All loads in this project are inductive (RL), so the current **lags** the voltage.
- p(t) = v(t) · i(t) = V<sub>RMS</sub>I<sub>RMS</sub>cos φ − V<sub>RMS</sub>I<sub>RMS</sub>cos(2ωt − φ)

Three charts share one time axis (3 cycles) and a linked hover cursor:

1. **Combined (primary):** v(t), i(t) and p(t) overlaid, oscilloscope-style. Each trace has its own vertical scale (V, mA, W), and all three scales are symmetric about zero so the zero lines coincide. p(t) is shaded, and a dashed line marks its mean, which equals the real power P. p(t) swings at 2f between S(cos φ − 1) and S(cos φ + 1); the parts below zero are energy that the inductance returns to the source.
2. **Voltage v(t)** on its own.
3. **Current i(t)** on its own, with dashed lines at ± the *measured* current peak. If the measured peak sits well above √2·I<sub>RMS</sub> (crest factor > 1.41), the real current is not sinusoidal.

The page labels all of these as *reconstructed · idealised*. Harmonics and distortion are not represented. A summary below the combined chart lists period, φ, current lag Δt, peaks, p(t) min/max, mean p(t) and reactive power Q.

## Bluetooth (AT-09)

The AT-09 is a CC2541 BLE module, typically running HM-10-compatible firmware. Most expose service **`FFE0`** with one characteristic **`FFE1`** (read / write-without-response / notify) carrying the UART data. Clones vary, so the UUIDs are configurable in **Settings** (16-bit or 128-bit).

Things to know:

- The AT-09 is **BLE only** — it never appears as a COM port; use the *Bluetooth* source.
- Each notification carries ≤ 20 bytes, so a ~60-byte record arrives in ~3 pieces. The line framer reassembles them.
- The module's default UART speed is **9600 baud** — match it in the firmware.
- The CC2541 is a 3.3 V part. Check that your breakout's RX tolerates the ATmega's 5 V TX, or add a divider.

### Verifying the module's UUIDs

1. **Phone (most reliable):** install *nRF Connect* (Android/iOS), scan, connect to the module (often named `BT05`, `HMSoft`, `MLT-BT05`…), and note each service/characteristic UUID and its properties. Enable notifications on the *Notify* characteristic — you should see `EM,1,…` arriving in chunks.
2. **AT commands (optional):** with the module on a USB-UART adapter and *not* connected over BLE, send `AT`, `AT+VERSION`, `AT+HELP`, `AT+UUID?`, `AT+CHAR?`. CC41-A firmware expects `\r\n` line endings; original HM-10 firmware expects none.
3. **PC:** `chrome://bluetooth-internals` shows whether your PC's adapter can see the module and its services.
4. **[BLE probe tool](tools/ble-probe.html):** connects from the browser, lists services/characteristics for a list of candidate UUIDs, streams raw notifications as text and hex, and can save the UUIDs it finds to the dashboard settings.

## Project structure

```
index.html                 dashboard page
css/styles.css             mobile-first styles, light/dark themes
js/
  main.js                  wiring: transport → framer → parser → store → UI
  config.js                defaults: baud rate, BLE UUIDs, buffer sizes
  protocol/
    line-framer.js         chunk → line reassembly
    em-parser.js           protocol v1 parser / formatter
  transports/
    transport.js           common interface (connect, disconnect, 'data', 'status')
    simulated.js           realistic fragmented protocol text, with occasional faults
    web-serial.js          USB serial
    web-bluetooth.js       BLE (AT-09 / HM-10)
    ble-uuid.js            UUID normalisation
  data/
    store.js               session recording (columnar)
    csv-export.js
  ui/                      cards, trend charts, waveforms, raw log, settings
vendor/uplot/              uPlot 1.6.32 (MIT) charting library
tests/                     in-browser tests for framer, parser, UUIDs, store, CSV, waveform maths
tools/ble-probe.html       BLE discovery tool
```

Every transport emits raw text chunks and status events only, so new connection types can be added without touching the dashboard or chart code.

## Deploying to GitHub Pages

1. Push to `main`.
2. In the repository, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. The site is published at `https://kishan-harry.github.io/UARTSerialReaderWebsite/`.

All paths are relative and there is no build step, so nothing else is needed. (`.nojekyll` disables Jekyll processing.)

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| *Port is in use* | Close the Arduino Serial Monitor or any other program using the COM port. |
| All lines rejected / "no line terminator" | Baud rate mismatch — check Settings. |
| First line after connecting rejected | Opening the port reset the board (DTR auto-reset); harmless. |
| *Service ffe0 not found* | Your module uses different UUIDs — use the BLE probe tool and update Settings. |
| Bluetooth chooser shows no devices (Android) | Turn on Bluetooth and Location, and grant Chrome the *Nearby devices* permission. |
| Status shows *No data* while connected | The device stopped sending, or (BLE) the ATmega isn't wired to the module's RX. |

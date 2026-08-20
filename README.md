# TradeGate Research

TradeGate is an independent multi-asset research platform. It is not affiliated with Tradegate AG.

## Data Status

The application now has a server-side data layer. It never exposes provider credentials to the browser.

| Provider | Coverage | Credential |
| --- | --- | --- |
| CoinGecko | Bitcoin quote and history | None |
| Twelve Data | Equities, ETFs, FX, and market history | `TWELVE_DATA_API_KEY` |
| FRED | Official U.S. macro and liquidity observations | `FRED_API_KEY` |

UI sections explicitly identify model previews. Scores, regimes, positioning, metals flows, and several international macro datasets remain prototypes until their calculation pipelines and licensed feeds are connected.

## Local Development

Requirements: Node.js 22 or newer and npm.

```bash
git clone https://github.com/AA-2020743/TradeGate.git
cd TradeGate
npm install
cp .env.example .env
npm run dev
```

`npm run dev` starts both services:

- Web application: `http://localhost:5173`
- Data API: `http://127.0.0.1:8787`

Check the API:

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/markets/snapshot
curl "http://127.0.0.1:8787/api/markets/history/BTC?range=1M"
```

## Provider Keys

Create `.env` from `.env.example` and set the server-side keys:

```dotenv
HOST=127.0.0.1
PORT=8787
TWELVE_DATA_API_KEY=your_twelve_data_key
FRED_API_KEY=your_fred_key
```

Never prefix these values with `VITE_`; doing so would expose them in the browser bundle. `.env` is ignored by Git.

- Twelve Data: create a key at `https://twelvedata.com/`.
- FRED: request a key at `https://fred.stlouisfed.org/docs/api/api_key.html`.

## Ubuntu VPS Deployment

The included examples assume Ubuntu, a domain such as `research.example.com`, and a dedicated `tradegate` service account.

### 1. Install packages

```bash
sudo apt update
sudo apt install -y git nginx curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

### 2. Create the service account and deploy

```bash
sudo useradd --system --create-home --shell /bin/bash tradegate
sudo -u tradegate git clone https://github.com/AA-2020743/TradeGate.git /home/tradegate/TradeGate
cd /home/tradegate/TradeGate
sudo -u tradegate npm ci
sudo -u tradegate cp .env.example .env
sudo -u tradegate nano .env
sudo -u tradegate npm run build
```

Set the real provider keys in `.env`. Keep `HOST=127.0.0.1` so the Node process is accessible only through Nginx.

### 3. Install the systemd service

```bash
sudo cp deploy/tradegate.service /etc/systemd/system/tradegate.service
sudo systemctl daemon-reload
sudo systemctl enable --now tradegate
sudo systemctl status tradegate
curl http://127.0.0.1:8787/api/health
```

View server logs with:

```bash
sudo journalctl -u tradegate -f
```

### 4. Configure Nginx

Edit the domain in `deploy/nginx.conf`, then run:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tradegate
sudo ln -s /etc/nginx/sites-available/tradegate /etc/nginx/sites-enabled/tradegate
sudo nginx -t
sudo systemctl reload nginx
```

Point the domain's DNS A/AAAA record to the VPS before enabling TLS.

### 5. Enable HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d research.example.com
```

Only ports 80 and 443 need to be public. Do not expose port 8787 through the VPS firewall.

## Updating Production

```bash
cd /home/tradegate/TradeGate
sudo -u tradegate git pull --ff-only
sudo -u tradegate npm ci
sudo -u tradegate npm run build
sudo systemctl restart tradegate
curl http://127.0.0.1:8787/api/health
```

## Production Commands

```bash
npm run build
npm start
```

The Express server serves both `/api/*` and the built React application from `dist/`.

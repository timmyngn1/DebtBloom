// ---------------------------------------------------------------------------
// DebtBloom backend
// This little server is the ONLY place your Plaid secret key lives. The browser
// never sees it. The browser asks this server to talk to Plaid on its behalf.
// ---------------------------------------------------------------------------
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Plaid client setup (reads your keys from the .env file) ---
const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
}));

// --- Very simple token storage ---
// When a bank is linked, Plaid gives us an "access_token". We save it to a
// local file so the connection survives server restarts. For a personal app
// this is fine; a real product would use a proper database with encryption.
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return []; }
}
function saveToken(entry) {
  const tokens = readTokens();
  tokens.push(entry);
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// --- Step 1: give the browser a short-lived link_token to open Plaid Link ---
app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: 'debtbloom-user' },
      client_name: 'DebtBloom',
      products: ['liabilities'],   // credit card balances + APRs
      country_codes: ['US'],
      language: 'en',
      // Real-time push updates arrive here — only works with a public URL.
      webhook: process.env.WEBHOOK_URL || undefined,
    });
    res.json({ link_token: response.data.link_token });
  } catch (e) {
    console.error('create_link_token error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not create link token. Check your keys in .env.' });
  }
});

// --- Step 2: swap the public_token (from the browser) for a lasting access_token ---
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const response = await plaid.itemPublicTokenExchange({
      public_token: req.body.public_token,
    });
    saveToken({ access_token: response.data.access_token, item_id: response.data.item_id });
    res.json({ ok: true });
  } catch (e) {
    console.error('exchange error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not link account.' });
  }
});

// --- TESTING ONLY (Sandbox): pretend a payment lowered your balance ---
// Real money never moves in Sandbox, so balances are fixed. This lets you
// prove the "paying down blooms the garden" feature works. Remove for launch.
let testReduction = 0;
app.post('/api/sandbox/simulate_payment', (req, res) => {
  testReduction += Number(req.body.amount) || 0;
  res.json({ ok: true, totalReduction: testReduction });
});

// --- Step 3: fetch current credit-card balances for every linked bank ---
app.get('/api/liabilities', async (req, res) => {
  try {
    const tokens = readTokens();
    const cards = [];
    for (const { access_token } of tokens) {
      // First get every account — this always works for any bank.
      const acctResp = await plaid.accountsGet({ access_token });
      const accounts = acctResp.data.accounts;

      // Then TRY to get liabilities for APR details. Some test banks don't
      // offer this, so if it fails we just carry on without the APR.
      let credit = [];
      try {
        const liab = await plaid.liabilitiesGet({ access_token });
        credit = (liab.data.liabilities && liab.data.liabilities.credit) || [];
      } catch (e) {
        console.log('(no liabilities detail for this bank — using account balances only)');
      }

      // Keep credit cards and loans; attach APR if we found it.
      for (const acct of accounts) {
        if (acct.type !== 'credit' && acct.type !== 'loan') continue;
        const match = credit.find(c => c.account_id === acct.account_id);
        const purchase = match
          ? ((match.aprs || []).find(a => a.apr_type === 'purchase_apr') || (match.aprs || [])[0])
          : null;
        cards.push({
          account_id: acct.account_id,
          name: acct.name || acct.official_name || 'Credit account',
          balance: Math.max(0, (((acct.balances && acct.balances.current) || 0) - testReduction)),
          apr: purchase ? purchase.apr_percentage : 0,
        });
      }
    }
    res.json({ cards });
  } catch (e) {
    console.error('liabilities error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not fetch balances.' });
  }
});

// --- Tells the browser whether any bank is connected yet ---
app.get('/api/status', (req, res) => {
  res.json({ connected: readTokens().length > 0 });
});

// --- Webhook receiver: Plaid POSTs here when data changes (real-time). ---
// This only fires if you set a public WEBHOOK_URL (see the README).
app.post('/api/webhook', (req, res) => {
  console.log('Plaid webhook received:', req.body.webhook_type, req.body.webhook_code);
  res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`DebtBloom running at http://localhost:${PORT}`);
  if (!process.env.PLAID_CLIENT_ID) {
    console.log('⚠  No Plaid keys found. Copy .env.example to .env and add your keys.');
  }
});

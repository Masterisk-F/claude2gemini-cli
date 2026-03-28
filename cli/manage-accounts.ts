import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DATA_DIR = path.join(process.cwd(), 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

interface Account {
  id: string;
  label: string;
  credentials: any;
}

function loadAccounts(): Account[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    return [];
  }
  const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('Failed to parse accounts.json:', e);
    return [];
  }
}

function saveAccounts(accounts: Account[]) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askMultiLine(question: string): Promise<string> {
  console.log(question);
  console.log('(入力を終了するには Ctrl+D を押してください)');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    let lines: string[] = [];
    rl.on('line', (line) => {
      lines.push(line);
    });
    rl.on('close', () => {
      resolve(lines.join('\n'));
    });
  });
}

async function addAccount() {
  console.log('\n=== Add Gemini Account ===\n');
  const label = await ask('Enter a label for this account (e.g., user@gmail.com): ');
  if (!label) {
    console.log('❌ Label is required.');
    return;
  }

  const credsRaw = await askMultiLine('Paste your credentials (content of oauth_creds.json):\n');
  
  let credentials;
  try {
    credentials = JSON.parse(credsRaw);
  } catch (e) {
    console.error('❌ Invalid JSON format. Please check your credentials and try again.');
    return;
  }

  const accounts = loadAccounts();
  const id = `account-${accounts.length}-${Date.now().toString(36)}`;
  
  accounts.push({ id, label, credentials });
  saveAccounts(accounts);

  console.log(`\n✅ Account "${label}" added successfully (ID: ${id})`);
  console.log(`Current account count: ${accounts.length}`);
}

function listAccounts() {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log('No accounts registered.');
    return;
  }

  console.log('\n=== Registered Accounts ===\n');
  console.table(accounts.map(a => ({
    ID: a.id,
    Label: a.label,
    Credentials: '*** (MASKED) ***'
  })));
}

async function removeAccount() {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log('No accounts to remove.');
    return;
  }

  listAccounts();
  const idToRemove = await ask('\nEnter the ID of the account to remove (or press Enter to cancel): ');
  if (!idToRemove) return;

  const filtered = accounts.filter(a => a.id !== idToRemove);
  if (filtered.length === accounts.length) {
    console.log(`❌ Account with ID "${idToRemove}" not found.`);
    return;
  }

  saveAccounts(filtered);
  console.log(`\n✅ Account "${idToRemove}" has been removed.`);
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'add':
      await addAccount();
      break;
    case 'list':
      listAccounts();
      break;
    case 'remove':
      await removeAccount();
      break;
    default:
      console.log('Usage: npm run account:[add|list|remove]');
  }
}

main().catch(console.error);

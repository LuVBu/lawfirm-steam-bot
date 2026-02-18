const { GoogleSpreadsheet } = require('google-spreadsheet');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamCommunity = require('steamcommunity');

// ========== ЧИТАЕМ НАСТРОЙКИ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ==========
const STEAM_USERNAME = process.env.STEAM_USERNAME;
const STEAM_PASSWORD = process.env.STEAM_PASSWORD;
const SHARED_SECRET = process.env.SHARED_SECRET;
const IDENTITY_SECRET = process.env.IDENTITY_SECRET;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS;

if (!STEAM_USERNAME || !STEAM_PASSWORD || !SHARED_SECRET || !IDENTITY_SECRET || !SPREADSHEET_ID || !GOOGLE_CREDENTIALS_JSON) {
  console.error('❌ Ошибка: не все переменные окружения заданы!');
  process.exit(1);
}

let googleCredentials;
try {
  googleCredentials = JSON.parse(GOOGLE_CREDENTIALS_JSON);
} catch (e) {
  console.error('❌ Ошибка парсинга GOOGLE_CREDENTIALS:', e.message);
  process.exit(1);
}

// ========== ИНИЦИАЛИЗАЦИЯ STEAM ==========
const client = new SteamUser();
const manager = new TradeOfferManager({
  steam: client,
  language: 'en',
  pollInterval: 10000
});
const community = new SteamCommunity();

client.logOn({
  accountName: STEAM_USERNAME,
  password: STEAM_PASSWORD,
  twoFactorCode: SteamTotp.getAuthCode(SHARED_SECRET)
});

client.on('loggedOn', () => {
  console.log('✅ Успешный вход в Steam');
  client.setPersona(1);
  client.gamesPlayed(440); // TF2
});

client.on('webSession', (sessionID, cookies) => {
  console.log('✅ Веб-сессия получена');
  manager.setCookies(cookies);
  community.setCookies(cookies);
  community.startConfirmationChecker(15000, IDENTITY_SECRET);
});

client.on('error', (err) => {
  console.error('❌ Ошибка Steam клиента:', err);
});

// ========== РАБОТА С GOOGLE TABLES ==========
async function processOrders() {
  try {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
    await doc.useServiceAccountAuth(googleCredentials);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['Покупка_ключей'];
    if (!sheet) {
      console.error('❌ Лист "Покупка_ключей" не найден');
      return;
    }

    const rows = await sheet.getRows();

    for (const row of rows) {
      const orderStatus = row.get('Статус заказа');
      const sentStatus = row.get('Статус отправки');

      if (orderStatus === 'Ожидает отправки' && sentStatus !== 'Отправлено') {
        const keyCount = parseInt(row.get('Количество ключей'));
        const tradeLink = row.get('Трейд-ссылка');
        const username = row.get('Username');

        console.log(`🔄 Обрабатываем заказ для ${username}: ${keyCount} ключей`);

        const partnerMatch = tradeLink.match(/partner=(\d+)/);
        const tokenMatch = tradeLink.match(/token=([a-zA-Z0-9_-]+)/);

        if (!partnerMatch || !tokenMatch) {
          console.error('❌ Неверный формат трейд-ссылки:', tradeLink);
          continue;
        }

        const partnerAccountId = partnerMatch[1];
        const token = tokenMatch[1];

        const offer = manager.createOffer(partnerAccountId);
        offer.setAccessToken(token);

        manager.getInventoryContents(440, 2, true, (err, myInventory) => {
          if (err) {
            console.error('❌ Ошибка получения инвентаря:', err);
            return;
          }

          const keys = myInventory.filter(item =>
            item.name === 'Mann Co. Supply Crate Key'
          ).slice(0, keyCount);

          if (keys.length < keyCount) {
            console.error(`❌ Недостаточно ключей. Есть: ${keys.length}, нужно: ${keyCount}`);
            return;
          }

          keys.forEach(key => offer.addMyItem(key));
          offer.setMessage('Your TF2 keys from Law Firm Steam! Better call Saul!');

          offer.send((err, status) => {
            if (err) {
              console.error('❌ Ошибка отправки трейда:', err);
            } else {
              console.log(`✅ Трейд отправлен! Статус: ${status}`);
              row.set('Статус отправки', 'Отправлено');
              row.save().catch(e => console.error('Ошибка сохранения строки:', e));
            }
          });
        });
      }
    }
  } catch (error) {
    console.error('❌ Ошибка при обработке заказов:', error);
  }
}

// Запускаем проверку каждые 30 секунд
setInterval(processOrders, 30000);
console.log('🚀 Бот мониторинга запущен. Проверка каждые 30 секунд...');

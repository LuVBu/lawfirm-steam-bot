const { GoogleSpreadsheet } = require('google-spreadsheet');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamCommunity = require('steamcommunity');

// ========== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ==========
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
  client.setPersona(1); // 1 = Online
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

// ========== РАБОТА С GOOGLE ТАБЛИЦЕЙ ==========
async function processOrders() {
  try {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
    await doc.useServiceAccountAuth(googleCredentials);
    await doc.loadInfo();

    // --- ЛИСТ 1: ПОКУПКА КЛЮЧЕЙ (бот продаёт) ---
    const buySheet = doc.sheetsByTitle['Покупка_ключей'];
    if (buySheet) {
      const rows = await buySheet.getRows();
      for (const row of rows) {
        // В версии 3.x используем row['Название столбца']
        const orderStatus = row['Статус заказа'];
        const sentStatus = row['Статус отправки'];

        if (orderStatus === 'Ожидает отправки' && sentStatus !== 'Трейд создан' && sentStatus !== 'Выполнен') {
          const keyCount = parseInt(row['Количество ключей']);
          const tradeLink = row['Трейд-ссылка'];
          const username = row['Username'];

          console.log(`🔄 Продажа: заказ для ${username} (${keyCount} ключей)`);

          const partnerMatch = tradeLink.match(/partner=(\d+)/);
          const tokenMatch = tradeLink.match(/token=([a-zA-Z0-9_-]+)/);

          if (!partnerMatch || !tokenMatch) {
            console.error('❌ Неверная ссылка:', tradeLink);
            continue;
          }

          const partnerAccountId = partnerMatch[1];
          const token = tokenMatch[1];

          const offer = manager.createOffer(partnerAccountId);
          offer.setAccessToken(token);

          manager.getInventoryContents(440, 2, true, (err, myInventory) => {
            if (err) {
              console.error('❌ Ошибка инвентаря:', err);
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
                console.log(`✅ Трейд отправлен! ID: ${offer.id}, статус: ${status}`);
                row['Статус отправки'] = 'Трейд создан';
                row.save().catch(e => console.error('Ошибка сохранения:', e));

                offer.on('accepted', () => {
                  console.log(`🎉 Трейд ${offer.id} принят!`);
                  row['Статус отправки'] = 'Выполнен';
                  row.save().catch(e => console.error('Ошибка сохранения после принятия:', e));
                });

                offer.on('declined', () => {
                  console.log(`❌ Трейд ${offer.id} отклонён.`);
                  row['Статус отправки'] = 'Отклонён';
                  row.save().catch(e => console.error('Ошибка сохранения после отклонения:', e));
                });
              }
            });
          });
        }
      }
    } else {
      console.warn('⚠️ Лист "Покупка_ключей" не найден');
    }

    // --- ЛИСТ 2: ПРОДАЖА КЛЮЧЕЙ (бот покупает) ---
    const sellSheet = doc.sheetsByTitle['Продажа_ключей'];
    if (sellSheet) {
      const rows = await sellSheet.getRows();
      for (const row of rows) {
        const orderStatus = row['Статус заказа'];
        const sentStatus = row['Статус отправки'];

        if (orderStatus === 'Ожидает получения' && sentStatus !== 'Трейд создан' && sentStatus !== 'Выполнен') {
          const keyCount = parseInt(row['Количество ключей']);
          const tradeLink = row['Трейд-ссылка'];
          const username = row['Username'];

          console.log(`🔄 Покупка: заказ для ${username} (${keyCount} ключей)`);

          const partnerMatch = tradeLink.match(/partner=(\d+)/);
          const tokenMatch = tradeLink.match(/token=([a-zA-Z0-9_-]+)/);

          if (!partnerMatch || !tokenMatch) {
            console.error('❌ Неверная ссылка:', tradeLink);
            continue;
          }

          const partnerAccountId = partnerMatch[1];
          const token = tokenMatch[1];

          const offer = manager.createOffer(partnerAccountId);
          offer.setAccessToken(token);
          offer.setMessage(`Please put ${keyCount} TF2 keys into this trade. After you confirm, I will send payment.`);

          offer.send((err, status) => {
            if (err) {
              console.error('❌ Ошибка создания запроса на получение ключей:', err);
            } else {
              console.log(`✅ Запрос на получение ключей отправлен! ID: ${offer.id}, статус: ${status}`);
              row['Статус отправки'] = 'Трейд создан';
              row.save().catch(e => console.error('Ошибка сохранения:', e));

              offer.on('accepted', () => {
                console.log(`🎉 Трейд ${offer.id} принят! Ключи получены.`);
                row['Статус отправки'] = 'Выполнен';
                row.save().catch(e => console.error('Ошибка сохранения после принятия:', e));
              });

              offer.on('declined', () => {
                console.log(`❌ Трейд ${offer.id} отклонён.`);
                row['Статус отправки'] = 'Отклонён';
                row.save().catch(e => console.error('Ошибка сохранения после отклонения:', e));
              });
            }
          });
        }
      }
    } else {
      console.warn('⚠️ Лист "Продажа_ключей" не найден');
    }

  } catch (error) {
    console.error('❌ Ошибка при обработке заказов:', error);
  }
}

// Запускаем проверку каждые 30 секунд
setInterval(processOrders, 30000);
console.log('🚀 Бот мониторинга запущен. Проверка каждые 30 секунд...');

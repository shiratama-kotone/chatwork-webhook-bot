const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 環境変数から設定を読み込み
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || '529205b4d731fe41c1f676e7081cc2b5';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'your-webhook-token'; // セキュリティ用

// 設定項目
const CHATWORK_GROUP_IDS = ['406897783', '391699365', '404646956','397972033','405755352','407676893'];

const ROOM_CONFIG = {
  '404646956': { memberSheetName: 'シート1', logSheetName: 'ログ' },
  '406897783': { memberSheetName: 'サブリスト', logSheetName: 'サブログ' },
  '391699365': { memberSheetName: '予備リスト', logSheetName: '予備ログ' },
  '397972033': { memberSheetName: '反省リスト', logSheetName: '反省ログ' },
  '405755352': { memberSheetName: 'アナセリスト', logSheetName: 'アナセログ' },
  '407676893': { memberSheetName: 'らいとリスト', logSheetName: 'らいとログ'}
};

// Chatwork絵文字のリスト
const CHATWORK_EMOJI_CODES = [
  "roger", "bow", "cracker", "dance", "clap", "y", "sweat", "blush", "inlove",
  "talk", "yawn", "puke", "emo", "nod", "shake", "^^;", ":/", "whew", "flex",
  "gogo", "think", "please", "quick", "anger", "devil", "lightbulb", "h", "F",
  "eat", "^", "coffee", "beer", "handshake"
].map(code => code.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));

const CHATWORK_EMOJI_REGEX = new RegExp(`\\((${CHATWORK_EMOJI_CODES.join('|')})\\)`, 'g');

// SQLiteデータベース設定
let db;

// データベース初期化
function initializeDatabase() {
  db = new sqlite3.Database('chatwork_bot.db');
  
  // テーブル作成
  db.serialize(() => {
    // メッセージID管理テーブル
    db.run(`CREATE TABLE IF NOT EXISTS message_tracking (
      room_id TEXT PRIMARY KEY,
      last_message_id TEXT,
      last_daily_greeting_date TEXT
    )`);
    
    // 日付イベントテーブル
    db.run(`CREATE TABLE IF NOT EXISTS date_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      event TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // ログテーブル
    db.run(`CREATE TABLE IF NOT EXISTS message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT,
      user_name TEXT,
      user_id TEXT,
      message_content TEXT,
      message_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // メンバー管理テーブル
    db.run(`CREATE TABLE IF NOT EXISTS members (
      room_id TEXT,
      account_id TEXT,
      name TEXT,
      role TEXT,
      join_date DATETIME,
      PRIMARY KEY (room_id, account_id)
    )`);
  });
}

// Express設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.json({ status: 'Chatwork Bot is running', timestamp: new Date().toISOString() });
});

// Webhook受信エンドポイント
app.post('/webhook', async (req, res) => {
  try {
    const { webhook_setting_id, webhook_event } = req.body;
    
    if (!webhook_event) {
      return res.status(400).json({ error: 'Invalid webhook data' });
    }
    
    const { room_id, account, body, message_id } = webhook_event;
    
    // 基本的な検証（Chatworkからのリクエストかどうか）
    if (!room_id || !account || !message_id) {
      return res.status(400).json({ error: 'Invalid webhook event data' });
    }
    
    // メッセージ処理
    await processWebhookMessage(room_id, {
      message_id,
      account,
      body
    });
    
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook処理エラー:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// メッセージ処理関数
async function processWebhookMessage(roomId, message) {
  try {
    if (!message.message_id || !message.account || !message.account.account_id || !message.account.name) {
      console.log(`ルーム ${roomId} の不完全なメッセージをスキップ`);
      return;
    }

    const currentMembers = await getChatworkMembers(roomId);
    const isDirectChat = currentMembers.length === 0;
    
    // ログ記録
    if (!isDirectChat) {
      await writeToLog(roomId, message.account.name, message.account.account_id, message.body, message.message_id);
    }

    const isSenderAdmin = isDirectChat ? true : isUserAdmin(message.account.account_id, currentMembers);
    const messageBody = message.body.trim();

    // 各種コマンド処理
    await handleCommands(roomId, message, messageBody, isSenderAdmin, currentMembers, isDirectChat);
    
    // メッセージID更新
    await updateLastMessageId(roomId, message.message_id);
    
  } catch (error) {
    console.error(`メッセージ処理エラー (room: ${roomId}):`, error);
  }
}

// コマンドハンドリング
async function handleCommands(roomId, message, messageBody, isSenderAdmin, currentMembers, isDirectChat) {
  const { account, message_id } = message;
  
  // 1. [toall] 検知と権限変更
  if (!isDirectChat && messageBody.includes('[toall]') && !isSenderAdmin) {
    console.log(`ルーム ${roomId} で [toall] を検出した非管理者: ${account.name}`);
    await changeMemberRole(roomId, account.account_id, 'readonly', account.name, `TOALL を使用したため`);
    await sleep(1000);
  }

  // 2. おみくじ機能
  if (messageBody === 'おみくじ') {
    const omikujiResult = drawOmikuji(isSenderAdmin);
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、[info][title]おみくじ[/title]おみくじの結果は…\n\n${omikujiResult}\n\nです！[/info]`;
    await sendChatworkMessage(roomId, replyMessage);
    await sleep(1000);
  }

  // 3. Chatwork絵文字50個以上で権限変更
  if (!isDirectChat && !isSenderAdmin) {
    const emojiCount = countChatworkEmojis(messageBody);
    if (emojiCount >= 50) {
      console.log(`ルーム ${roomId} で Chatwork絵文字50個以上を検出した非管理者: ${account.name}, 絵文字数: ${emojiCount}`);
      await changeMemberRole(roomId, account.account_id, 'readonly', account.name, `Chatwork絵文字を${emojiCount}個送信したため`);
      await sleep(1000);
    }
  }

  // 4. /day-write コマンド
  if (messageBody.startsWith('/day-write ')) {
    await handleDayWriteCommand(roomId, message, messageBody);
  }

  // 5. /yes-or-no コマンド
  if (messageBody === '/yes-or-no') {
    const answer = await getYesOrNoAnswer();
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、答えは「${answer}」です！`;
    await sendChatworkMessage(roomId, replyMessage);
    await sleep(1000);
  }

  // 6. /wiki コマンド
  if (messageBody.startsWith('/wiki/')) {
    await handleWikiCommand(roomId, message, messageBody);
  }

  // 7. /scratch-user コマンド
  if (messageBody.startsWith('/scratch-user/')) {
    await handleScratchUserCommand(roomId, message, messageBody);
  }

  // 8. /scratch-project コマンド
  if (messageBody.startsWith('/scratch-project/')) {
    await handleScratchProjectCommand(roomId, message, messageBody);
  }

  // 9. /today コマンド
  if (messageBody === '/today') {
    await handleTodayCommand(roomId, message);
  }

  // 10. /day-view コマンド
  if (messageBody === '/day-view') {
    await handleDayViewCommand(roomId, message);
  }

  // 11. /member コマンド
  if (messageBody === '/member' && !isDirectChat) {
    await handleMemberCommand(roomId, message);
  }

  // 12. /member-name コマンド
  if (messageBody === '/member-name' && !isDirectChat) {
    await handleMemberNameCommand(roomId, message);
  }

  // 13-15. 特定のユーザー呼び出し
  await handleUserMentions(roomId, message, messageBody);
}

// 特定のユーザー呼び出し処理
async function handleUserMentions(roomId, message, messageBody) {
  const { account, message_id } = message;
  
  if (messageBody === 'はんせい') {
    const replyMessage = `[To:9859068] なかよし\n[pname:${account.account_id}]に呼ばれてるよ！`;
    await sendChatworkMessage(roomId, replyMessage);
    await sleep(1000);
  }
  
  if (messageBody === 'ゆゆゆ') {
    const replyMessage = `[To:10544705] ゆゆゆ\n[pname:${account.account_id}]に呼ばれてるよ！`;
    await sendChatworkMessage(roomId, replyMessage);
    await sleep(1000);
  }
  
  if (messageBody === 'からめり') {
    const replyMessage = `[To:10337719] からめり\n[pname:${account.account_id}]に呼ばれてるよ！`;
    await sendChatworkMessage(roomId, replyMessage);
    await sleep(1000);
  }
}

// 各種コマンドハンドラー
async function handleDayWriteCommand(roomId, message, messageBody) {
  const { account, message_id } = message;
  const dateAndEvent = messageBody.substring('/day-write '.length).trim();
  const firstSpaceIndex = dateAndEvent.indexOf(' ');

  if (firstSpaceIndex > 0) {
    const dateStr = dateAndEvent.substring(0, firstSpaceIndex);
    const event = dateAndEvent.substring(firstSpaceIndex + 1);
    
    try {
      let formattedDate;
      const dateParts = dateStr.split('-');

      if (dateParts.length === 3) { // yyyy-mm-dd
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]);
        const day = parseInt(dateParts[2]);
        if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
          formattedDate = `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
        }
      } else if (dateParts.length === 2) { // mm-dd
        const month = parseInt(dateParts[0]);
        const day = parseInt(dateParts[1]);
        if (!isNaN(month) && !isNaN(day)) {
          formattedDate = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
        }
      } else if (dateParts.length === 1) { // dd
        const day = parseInt(dateParts[0]);
        if (!isNaN(day)) {
          formattedDate = `${String(day).padStart(2, '0')}`;
        }
      }

      if (formattedDate) {
        await addDateToList(formattedDate, event);
        await sendChatworkMessage(roomId, `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、${formattedDate} のイベント「${event}」を日付リストに登録しました。`);
      } else {
        await sendChatworkMessage(roomId, `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、日付の形式が正しくありません。「yyyy-mm-dd」「mm-dd」「dd」形式で入力してください。`);
      }
    } catch (e) {
      await sendChatworkMessage(roomId, `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、日付の解析中にエラーが発生しました。`);
    }
  } else {
    await sendChatworkMessage(roomId, `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、コマンドの形式が正しくありません。「/day-write yyyy-mm-dd 〇〇の日」のように入力してください。`);
  }
  await sleep(1000);
}

async function handleWikiCommand(roomId, message, messageBody) {
  const { account, message_id } = message;
  const searchTerm = messageBody.substring('/wiki/'.length).trim();
  
  if (searchTerm) {
    const wikipediaSummary = await getWikipediaSummary(searchTerm);
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、Wikipediaの検索結果です。\n\n${wikipediaSummary}`;
    await sendChatworkMessage(roomId, replyMessage);
  } else {
    await sendChatworkMessage(roomId, `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、検索キーワードを指定してください。「/wiki/検索したいこと」のように入力してください。`);
  }
  await sleep(1000);
}

async function handleScratchUserCommand(roomId, message, messageBody) {
  const { account, message_id } = message;
  const username = messageBody.substring('/scratch-user/'.length).trim();
  
  if (username) {
    const userStats = await getScratchUserStats(username);
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、Scratchユーザー「${username}」の情報です。\n\n${userStats}`;
    await sendChatworkMessage(roomId, replyMessage);
  } else {
    await sendChatworkMessage(roomId, `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、ユーザー名を指定してください。「/scratch-user/[ユーザー名]」のように入力してください。`);
  }
  await sleep(1000);
}

async function handleScratchProjectCommand(roomId, message, messageBody) {
  const { account, message_id } = message;
  const projectId = messageBody.substring('/scratch-project/'.length).trim();
  
  if (projectId) {
    const projectStats = await getScratchProjectStats(projectId);
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、Scratchプロジェクト「${projectId}」の情報です。\n\n${projectStats}`;
    await sendChatworkMessage(roomId, replyMessage);
  } else {
    await sendChatworkMessage(roomId, `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、プロジェクトIDを指定してください。「/scratch-project/[プロジェクトID]」のように入力してください。`);
  }
  await sleep(1000);
}

async function handleTodayCommand(roomId, message) {
  const { account, message_id } = message;
  const now = new Date();
  const todayFormatted = formatDate(now, 'yyyy年MM月dd日');
  const todayKeyFull = formatDate(now, 'yyyy/MM/dd');
  const todayKeyYearly = formatDate(now, 'MM/dd');
  const todayKeyMonthly = formatDate(now, 'dd');
  
  let messageContent = `[info][title]今日の情報[/title]今日は${todayFormatted}だよ！`;
  
  const dateEvents = await getDateEvents();
  let eventFound = false;
  
  for (const event of dateEvents) {
    const sheetDateFormatted = event.date.toString().replace('*', '').replace(/-/g, '/');
    if (sheetDateFormatted === todayKeyFull || sheetDateFormatted === todayKeyYearly || sheetDateFormatted === todayKeyMonthly) {
      messageContent += `\n今日は${event.event}だよ！`;
      eventFound = true;
    }
  }
  
  if (!eventFound) {
    messageContent += `\n今日は特に登録されたイベントはないみたい。`;
  }
  messageContent += `[/info]`;
  
  const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、\n\n${messageContent}`;
  await sendChatworkMessage(roomId, replyMessage);
  await sleep(1000);
}

async function handleDayViewCommand(roomId, message) {
  const { account, message_id } = message;
  const dateEvents = await getDateEvents();
  
  if (dateEvents.length === 0) {
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、日付リストにはまだイベントが登録されていません。`;
    await sendChatworkMessage(roomId, replyMessage);
    return;
  }
  
  let messageContent = `[info][title]日付一覧[/title]`;
  for (const event of dateEvents) {
    let displayDate = event.date;
    const dateParts = event.date.toString().split('-');
    if (dateParts.length === 2 && dateParts[0] === '*') { // 月・日指定
      displayDate = dateParts[1];
    } else if (dateParts.length === 1 && dateParts[0].startsWith('*')) { // 日指定
      displayDate = dateParts[0].substring(1);
    }
    messageContent += `\n${displayDate} ${event.event}`;
  }
  messageContent += `[/info]`;
  
  const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、\n\n${messageContent}`;
  await sendChatworkMessage(roomId, replyMessage);
  await sleep(1000);
}

async function handleMemberCommand(roomId, message) {
  const { account, message_id } = message;
  const members = await getChatworkMembers(roomId);
  
  if (!members || members.length === 0) {
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、メンバー情報の取得に失敗しました。`;
    await sendChatworkMessage(roomId, replyMessage);
    return;
  }

  let memberListText = members.map(member => `[picon:${member.account_id}]${member.name}`).join('\n');
  let messageContent = `[info][title]メンバー一覧[/title]${memberListText}\n[/info]`;

  const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、\n\n${messageContent}`;
  await sendChatworkMessage(roomId, replyMessage);
  await sleep(1000);
}

async function handleMemberNameCommand(roomId, message) {
  const { account, message_id } = message;
  const members = await getChatworkMembers(roomId);
  
  if (!members || members.length === 0) {
    const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、メンバー情報の取得に失敗しました。`;
    await sendChatworkMessage(roomId, replyMessage);
    return;
  }

  let memberListText = members.map(member => member.name).join('\n');
  let messageContent = `[info][title]メンバー名一覧[/title]${memberListText}\n[/info]`;

  const replyMessage = `[rp aid=${account.account_id} to=${roomId}-${message_id}][pname:${account.account_id}]さん、\n\n${messageContent}`;
  await sendChatworkMessage(roomId, replyMessage);
  await sleep(1000);
}

// 日次挨拶メッセージの定期実行設定
cron.schedule('0 0 * * *', async () => {
  console.log('日次挨拶メッセージ送信を開始します');
  for (const roomId of CHATWORK_GROUP_IDS) {
    try {
      await sendDailyGreetingMessage(roomId);
      await sleep(1000);
    } catch (error) {
      console.error(`ルーム ${roomId} での日次挨拶送信エラー:`, error);
    }
  }
});

// 日次挨拶メッセージ送信
async function sendDailyGreetingMessage(roomId) {
  const now = new Date();
  const todayFormatted = formatDate(now, 'yyyy年MM月dd日');
  const todayKeyFull = formatDate(now, 'yyyy/MM/dd');
  const todayKeyYearly = formatDate(now, 'MM/dd');
  const todayKeyMonthly = formatDate(now, 'dd');
  const todayDateOnly = formatDate(now, 'yyyy-MM-dd');

  const lastSentDate = await getLastDailyGreetingDate(roomId);
  
  if (lastSentDate !== todayDateOnly) {
    let message = `[info][title]日付変更！[/title]今日は${todayFormatted}だよ！`;
    
    const dateEvents = await getDateEvents();
    for (const event of dateEvents) {
      const sheetDateFormatted = event.date.toString().replace('*', '').replace(/-/g, '/');
      if (sheetDateFormatted === todayKeyFull || sheetDateFormatted === todayKeyYearly || sheetDateFormatted === todayKeyMonthly) {
        message += `\n今日は${event.event}だよ！`;
      }
    }
    message += `[/info]`;
    
    await sendChatworkMessage(roomId, message);
    await setLastDailyGreetingDate(roomId, todayDateOnly);
  }
}

// ユーティリティ関数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(date, format) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return format
    .replace('yyyy', year)
    .replace('MM', month)
    .replace('dd', day);
}

function countChatworkEmojis(text) {
  const matches = text.match(CHATWORK_EMOJI_REGEX);
  return matches ? matches.length : 0;
}

function drawOmikuji(isAdmin) {
  const fortunes = ['大吉', '中吉', '吉', '小吉', 'null', 'undefined'];
  const specialFortune = '超町長調帳朝腸蝶大吉';
  let specialChance = 0.002;
  if (isAdmin) {
    specialChance = 0.25;
  }
  const rand = Math.random();
  if (rand < specialChance) {
    return specialFortune;
  } else {
    const remainingFortunes = fortunes.slice();
    const index = Math.floor(Math.random() * remainingFortunes.length);
    return remainingFortunes[index];
  }
}

function isUserAdmin(accountId, allMembers) {
  const user = allMembers.find(member => member.account_id === accountId);
  return user && user.role === 'admin';
}

// API関連関数
async function getChatworkMembers(roomId) {
  try {
    const response = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    
    return response.data.map(member => ({
      account_id: member.account_id,
      name: member.name,
      role: member.role
    }));
  } catch (error) {
    console.error(`ルーム ${roomId} のChatworkメンバー取得エラー:`, error.message);
    return [];
  }
}

async function sendChatworkMessage(roomId, message) {
  try {
    await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, 
      new URLSearchParams({ body: message }), {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    console.log(`ルーム ${roomId} にメッセージを送信しました。`);
  } catch (error) {
    console.error(`ルーム ${roomId} へのメッセージ送信エラー:`, error.message);
  }
}

async function changeMemberRole(roomId, targetAccountId, newRole, userName, changeReason = "") {
  try {
    const currentMembers = await getChatworkMembers(roomId);
    if (!currentMembers || currentMembers.length === 0) {
      console.log(`ルーム ${roomId} の役割変更のための現在のメンバーリスト取得に失敗しました。`);
      return;
    }
    
    const adminIds = currentMembers.filter(m => m.role === 'admin').map(m => m.account_id);
    const memberIds = currentMembers.filter(m => m.role === 'member').map(m => m.account_id);
    const readonlyIds = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id);
    
    let newAdminIds = adminIds.filter(id => id !== targetAccountId);
    let newMemberIds = memberIds.filter(id => id !== targetAccountId);
    let newReadonlyIds = readonlyIds.filter(id => id !== targetAccountId);
    
    if (newRole === 'admin') {
      newAdminIds.push(targetAccountId);
    } else if (newRole === 'member') {
      newMemberIds.push(targetAccountId);
    } else if (newRole === 'readonly') {
      newReadonlyIds.push(targetAccountId);
    }
    
    const payload = new URLSearchParams({
      'members_admin_ids': newAdminIds.join(','),
      'members_member_ids': newMemberIds.join(','),
      'members_readonly_ids': newReadonlyIds.join(',')
    });
    
    await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}/members`, payload, {
      headers: { 
        'X-ChatWorkToken': CHATWORK_API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    console.log(`ルーム ${roomId} の ${userName} (${targetAccountId}) の権限を ${newRole} に変更しました。`);
    
    let notificationMessage = `[info][title]権限変更のお知らせ[/title][To:${targetAccountId}][pname:${targetAccountId}]さんの権限を「閲覧のみ」に変更しました。`;
    if (changeReason) {
      notificationMessage += `\n理由: ${changeReason}`;
    }
    notificationMessage += `\nルームルールに基づき、ご協力をお願いいたします。[/info]`;
    await sendChatworkMessage(roomId, notificationMessage);
  } catch (error) {
    console.error(`ルーム ${roomId} のメンバー役割変更エラー:`, error.message);
    await sendChatworkMessage(roomId, `[error][title]権限変更エラー[/title][To:${targetAccountId}][pname:${targetAccountId}]さんの権限変更に失敗しました。管理者にご連絡ください。[/error]`);
  }
}

async function getYesOrNoAnswer() {
  try {
    const response = await axios.get('https://yesno.wtf/api');
    return response.data.answer || '不明';
  } catch (error) {
    console.error('yesno.wtf API呼び出しエラー:', error.message);
    return 'APIエラーにより取得できませんでした。';
  }
}

async function getWikipediaSummary(searchTerm) {
  try {
    const params = {
      action: 'query',
      format: 'json',
      prop: 'extracts',
      exintro: true,
      explaintext: true,
      redirects: 1,
      titles: searchTerm
    };
    
    const response = await axios.get('https://ja.wikipedia.org/w/api.php', { params });
    const jsonResponse = response.data;
    
    if (jsonResponse.query && jsonResponse.query.pages) {
      const pages = jsonResponse.query.pages;
      const pageId = Object.keys(pages)[0];
      if (pageId && pages[pageId] && pages[pageId].extract) {
        let summary = pages[pageId].extract;
        if (summary.length > 500) {
          summary = summary.substring(0, 500) + '...';
        }
        const pageTitle = pages[pageId].title;
        const pageUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`;
        return `${summary}\n\n元記事: ${pageUrl}`;
      } else if (pageId && pages[pageId].missing !== undefined) {
        return `「${searchTerm}」に関する記事は見つかりませんでした。`;
      }
    }
    return `「${searchTerm}」の検索結果を処理できませんでした。`;
  } catch (error) {
    console.error('Wikipedia API呼び出しエラー:', error.message);
    return `Wikipedia検索中にエラーが発生しました。「${searchTerm}」`;
  }
}

async function getScratchUserStats(username) {
  try {
    const response = await axios.get(`https://api.scratch.mit.edu/users/${encodeURIComponent(username)}`);
    const jsonResponse = response.data;
    const status = jsonResponse.profile?.status ?? '情報なし';
    const userLink = `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;
    return `[info][title]Scratchユーザー情報[/title]ユーザー名: ${username}\nステータス: ${status}\nユーザーページ: ${userLink}[/info]`;
  } catch (error) {
    if (error.response?.status === 404) {
      return `「${username}」というScratchユーザーは見つかりませんでした。`;
    }
    console.error('ScratchユーザーAPI呼び出しエラー:', error.message);
    return `Scratchユーザー情報の取得中にエラーが発生しました。`;
  }
}

async function getScratchProjectStats(projectId) {
  try {
    const response = await axios.get(`https://api.scratch.mit.edu/projects/${encodeURIComponent(projectId)}`);
    const jsonResponse = response.data;
    const title = jsonResponse.title || 'タイトルなし';
    const views = jsonResponse.stats?.views ?? '情報なし';
    const loves = jsonResponse.stats?.loves ?? '情報なし';
    const favorites = jsonResponse.stats?.favorites ?? '情報なし';
    const remixes = jsonResponse.stats?.remixes ?? '情報なし';
    const projectLink = `https://scratch.mit.edu/projects/${encodeURIComponent(projectId)}/`;
    return `[info][title]Scratchプロジェクト情報[/title]タイトル: ${title}\n閲覧数: ${views}\n好きの数: ${loves}\nお気に入りの数: ${favorites}\nリミックス数: ${remixes}\nプロジェクトページ: ${projectLink}[/info]`;
  } catch (error) {
    if (error.response?.status === 404) {
      return `「${projectId}」というScratchプロジェクトは見つかりませんでした。`;
    }
    console.error('ScratchプロジェクトAPI呼び出しエラー:', error.message);
    return `Scratchプロジェクト情報の取得中にエラーが発生しました。`;
  }
}

// データベース関連関数
async function updateLastMessageId(roomId, messageId) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO message_tracking (room_id, last_message_id) VALUES (?, ?)`,
      [roomId, messageId],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function getLastDailyGreetingDate(roomId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT last_daily_greeting_date FROM message_tracking WHERE room_id = ?`,
      [roomId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row?.last_daily_greeting_date || null);
      }
    );
  });
}

async function setLastDailyGreetingDate(roomId, date) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO message_tracking (room_id, last_daily_greeting_date) VALUES (?, ?)`,
      [roomId, date],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function addDateToList(date, event) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO date_events (date, event) VALUES (?, ?)`,
      [date, event],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function getDateEvents() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM date_events ORDER BY created_at`,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

async function writeToLog(roomId, userName, userId, messageContent, messageId) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO message_logs (room_id, user_name, user_id, message_content, message_id) VALUES (?, ?, ?, ?, ?)`,
      [roomId, userName, userId, messageContent, messageId],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// サーバー起動
app.listen(PORT, () => {
  // 必須環境変数のチェック
  if (!CHATWORK_API_TOKEN) {
    console.error('ERROR: CHATWORK_API_TOKEN環境変数が設定されていません');
    process.exit(1);
  }
  
  console.log(`Chatwork Bot server is running on port ${PORT}`);
  initializeDatabase();
  console.log('データベースを初期化しました');
});

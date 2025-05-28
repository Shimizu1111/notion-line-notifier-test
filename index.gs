// 定数はPropertiesServiceで管理
const USER_DB_ID = PropertiesService.getScriptProperties().getProperty('USER_DB_ID');
const CASE_NOTE_DB_ID = PropertiesService.getScriptProperties().getProperty('CASE_NOTE_DB_ID');
const NOTION_API_KEY = PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY');
const LINE_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_ACCESS_TOKEN');
const SECRET_TOKEN = PropertiesService.getScriptProperties().getProperty('SECRET_TOKEN');

/**
 * CL送付対象のユーザを判定し、LINEまたはメールで通知を送る処理
 */
function sendCLNotifications() {
  const userList = getDatabaseData(USER_DB_ID);
  const caseNoteList = getDatabaseData(CASE_NOTE_DB_ID);

  caseNoteList.forEach(contact => {
    const status = contact.properties['CL作成']?.status?.name;
    if (status === 'LINE送付前') {
      sendCL(contact, userList);
    }
  });
}

/**
 * 個別CL送付処理
 * @param {Object} contact ケースノートページオブジェクト
 * @param {Array} userList ユーザーデータリスト
 */
function sendCL(contact, userList) {
  const contactName = getPlainText(contact.properties['タイトル']?.title || []);
  const relatedUserId = contact.properties['MemberList']?.relation?.[0]?.id;

  if (!relatedUserId) {
    console.warn(`リレーション未設定: ${contactName}`);
    return;
  }

  const user = userList.find(u => u.id === relatedUserId);
  if (!user) {
    console.warn(`ユーザ未発見: ${contactName}`);
    return;
  }

  const lineId = getPlainText(user.properties['LineUserID']?.rich_text || []);
  const email = user.properties['メールアドレス']?.email || '';
  const idValue = user.properties['ID']?.unique_id?.number;

  if (lineId) {
    const message = `ケースノートが更新されました`;
    sendLineMessage(lineId, message);
    console.log(`LINE送信完了 → ${contactName}: ${lineId}`);
  } else if (email) {
    // TODO: liffnoURLはお客様側で新規作成いただいたログインAPIのリンクを設定ください
    // const inviteText = `LINE連携の手続きはこちら（次回以降LINEにて通知をお送りします）\n\n` +
    //   `▶ https://liff.line.me/2007402756-opA2x8xg/?id=${idValue}`;
    const inviteText = `LINE連携の手続きはこちら（次回以降LINEにて通知をお送りします）\n\n` +
      `▶ https://liff.line.me/2007492708-7Dpan89p/?id=${idValue}`;
    GmailApp.sendEmail(email, 'LINE連携の手続き', inviteText);
    console.log(`メール送信完了 → ${contactName}: ${email}`);
  } else {
    console.warn(`連絡先なし → ${contactName}`);
    return;
  }

  updateLineSentStatus(contact.id);
}

/**
 * LINEメッセージ送信
 * @param {string} lineId 送信先LINEユーザID
 * @param {string} messageText 送信メッセージ
 */
function sendLineMessage(lineId, messageText) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const payload = {
    to: lineId,
    messages: [{ type: 'text', text: messageText }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    console.log(`LINE送信成功: ${response.getResponseCode()} ${response.getContentText()}`);
  } catch (e) {
    console.error(`LINE送信エラー: ${e}`);
  }
}

/**
 * Notionステータス更新
 * @param {string} pageId ページID
 */
function updateLineSentStatus(pageId) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const payload = {
    properties: {
      "CL作成": { status: { name: "CR送付&LINE済" } }
    }
  };

  const options = {
    method: 'patch',
    headers: {
      Authorization: 'Bearer ' + NOTION_API_KEY,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    console.log(`CL作成ステータス更新完了: ${pageId} (HTTP ${response.getResponseCode()})`);
  } catch (e) {
    console.error(`CL作成ステータス更新エラー: ${e}`);
  }
}

/**
 * LINEユーザID登録用POSTハンドラ
 * @param {object} e イベントオブジェクト
 * @returns {ContentService.TextOutput} JSONレスポンス
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    const token = data.token;
    const userId = data.userId;
    const lineUserId = data.lineUserId;

    if (token !== SECRET_TOKEN) {
      console.warn(`不正なトークンアクセス: ${token}`);
      return createCorsResponse({ error: "Invalid token" });
    }

    if (!userId || !lineUserId) {
      return createCorsResponse({ error: "Missing userId or lineUserId" });
    }

    const result = updateLineUserId(userId, lineUserId);
    return createCorsResponse(result);

  } catch (err) {
    console.error('doPost エラー:', err);
    return createCorsResponse({ error: "Invalid request format" });
  }
}

function doOptions() {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT)
    .setHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
}

function createCorsResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
}


/**
 * Notion DB上のユーザのLineUserIDを更新
 * @param {string} userId 独自ID
 * @param {string} lineUserId LINEユーザID
 * @returns {object} 結果オブジェクト
 */
function updateLineUserId(userId, lineUserId) {
  const users = getDatabaseData(USER_DB_ID);

  const userPage = users.find(user => user.properties['ID']?.unique_id?.number == userId);
  if (!userPage) {
    return { error: `User with ID ${userId} not found` };
  }

  const pageId = userPage.id;
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const payload = {
    properties: {
      "LineUserID": {
        rich_text: [{ text: { content: lineUserId } }]
      }
    }
  };

  const options = {
    method: 'patch',
    headers: {
      Authorization: 'Bearer ' + NOTION_API_KEY,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    return { message: "LINE ID updated", response: response.getContentText() };
  } catch (error) {
    return { error: error.toString() };
  }
}

/**
 * Notionデータベースからページ一覧を取得
 * @param {string} databaseId データベースID
 * @returns {Array} ページリスト
 */
function getDatabaseData(databaseId) {
  const url = `https://api.notion.com/v1/databases/${databaseId}/query`;
  const content_data = {};
  if(databaseId === CASE_NOTE_DB_ID)
  {
    const content_data = {
      "filter": {
        "property": "ステータス",
          "select": {
            "equal": "LINE送付前"
          }
      }
    }
  }
  const options = {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + NOTION_API_KEY,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    payload: JSON.stringify({}),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    return result.results || [];
  } catch (e) {
    console.error(`データ取得エラー: ${e}`);
    return [];
  }
}

/**
 * Notionリッチテキストをプレーンテキストに変換
 * @param {Array} valueArray リッチテキスト配列
 * @returns {string} プレーンテキスト
 */
function getPlainText(valueArray) {
  if (!valueArray || valueArray.length === 0) return '';
  return valueArray.map(v => v.plain_text).join('');
}

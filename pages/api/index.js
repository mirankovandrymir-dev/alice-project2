const GEMINI_MODEL = 'gemini-3.6-flash';

const SEARCH_WORDS = [
  'сегодня','сейчас','последние','последний','последняя','новости','новость','актуаль','курс','цена','стоимость','погода','температура','расписание','результат','результаты','события','кто сейчас','сколько стоит','на данный момент','2026'
];

function needsSearch(text) {
  const t = text.toLowerCase();
  return SEARCH_WORDS.some((word) => t.includes(word));
}

function cleanVoiceText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/#{1,6}\s?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function readHistory(state) {
  const h = state?.session?.h;
  return Array.isArray(h) ? h.filter((x) => typeof x === 'string').slice(-3) : [];
}

function saveHistory(history, userText, answer) {
  const compactUser = userText.slice(0, 150);
  const compactAnswer = answer.slice(0, 150);
  return [...history, `Пользователь: ${compactUser}\nАссистент: ${compactAnswer}`].slice(-3);
}

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 5 })
  });
  if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
  const data = await response.json();
  return (data.organic || []).slice(0, 5).map((r) => ({
    title: r.title || '',
    snippet: r.snippet || '',
    link: r.link || ''
  }));
}

async function askGemini(userText, history, searchResults) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not configured');

  const context = history.length ? `Предыдущий контекст:\n${history.join('\n')}\n\n` : '';
  const web = searchResults.length
    ? `Актуальные результаты поиска. Используй их только как источник фактов и не зачитывай ссылки:\n${searchResults.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.link}`).join('\n')}`
    : '';

  const prompt = `${context}${web}\n\nТекущий запрос пользователя: ${userText}`;
  const body = {
    systemInstruction: {
      parts: [{ text: 'Ты голосовой помощник для навыка Яндекс Алисы. Отвечай на русском. Отвечай кратко: обычно 1–3 коротких предложения. Не используй Markdown, списки, эмодзи и длинные вступления. Если нужны актуальные данные, опирайся на результаты поиска. Не выдумывай факты. Если данных недостаточно, честно скажи об этом.' }]
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 300 }
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }
  const data = await response.json();
  return cleanVoiceText(data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join(' '));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'alice-gemini-serper' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const userText = String(body?.request?.command || body?.request?.original_utterance || '').trim();
    const history = readHistory(body?.state);

    if (!userText) {
      return res.status(200).json({
        response: { text: 'Я слушаю. Что вы хотите узнать?', end_session: false },
        session_state: { h: history },
        version: '1.0'
      });
    }

    let searchResults = [];
    if (needsSearch(userText)) {
      try { searchResults = await serperSearch(userText); } catch (e) { console.error('Serper error:', e.message); }
    }

    const answer = await askGemini(userText, history, searchResults) || 'Не смог сформулировать ответ. Попробуйте ещё раз.';
    const newHistory = saveHistory(history, userText, answer);

    return res.status(200).json({
      response: { text: answer, end_session: false },
      session_state: { h: newHistory },
      version: '1.0'
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({
      response: { text: 'Произошла ошибка при обработке запроса. Попробуйте ещё раз.', end_session: false },
      session_state: { h: readHistory(req.body?.state) },
      version: '1.0'
    });
  }
}
const express = require('express');
const Sentiment = require('sentiment');
const sentiment = new Sentiment();

const app = express();
app.use(express.json());

app.post('/api/analyze-sentiment', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  const result = sentiment.analyze(text);

  // result.score là số điểm sentiment (âm: tiêu cực, dương: tích cực, 0: trung tính)
  let sentimentLabel = 'Unknown';
  if (result.score > 0) sentimentLabel = 'Positive';
  else if (result.score < 0) sentimentLabel = 'Negative';

  res.json({ sentiment: sentimentLabel, score: result.score });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Sentiment API running on port ${PORT}`);
});
module.exports = {
  analyze(text) {
    text = text.toLowerCase();

    if (text.includes('excellent') || text.includes('great') || text.includes('highly recommend') || text.includes('best')) {
      return 'Positive';
    } else if (text.includes('bad') || text.includes('poor') || text.includes('worse') || text.includes('issue')) {
      return 'Negative';
    } else {
      return 'Neutral';
    }
  }
};

  
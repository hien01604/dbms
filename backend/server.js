const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const Sentiment = require('sentiment');
const sentiment = new Sentiment();

const app = express();

app.use(cors());
app.use(express.json());

const config = {
  user: 'sa',
  password: '123',
  server: 'mhien',
  database: 'product_fb',
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

const poolPromise = sql.connect(config).catch(err => {
  console.error('Error connecting to database:', err.message);
});

// API lấy danh sách sản phẩm kèm feedback, tính AvgRating ở backend
app.get('/products', async (req, res) => {
  try {
    const pool = await poolPromise;

    // Lấy sản phẩm kèm tất cả feedback của từng sản phẩm (left join)
    const result = await pool.request().query(`
      SELECT p.ProductID, p.Title, p.Price,
             p.Status,
             cf.FeedbackID, cf.CustomerName, cf.FeedbackText, cf.CRating, cf.Sentiment
      FROM Products p
      LEFT JOIN CustomerFeedback cf ON p.ProductID = cf.ProductID
    `);

    const productsMap = new Map();

    // Gom feedback theo product
    result.recordset.forEach(row => {
      if (!productsMap.has(row.ProductID)) {
        productsMap.set(row.ProductID, {
          ProductID: row.ProductID,
          Title: row.Title,
          Price: row.Price,
          Status: row.Status,
          Feedback: []
        });
      }
      if (row.FeedbackID) {
        productsMap.get(row.ProductID).Feedback.push({
          FeedbackID: row.FeedbackID,
          CustomerName: row.CustomerName,
          FeedbackText: row.FeedbackText,
          CRating: row.CRating,
          Sentiment: row.Sentiment
        });
      }
    });

    const products = Array.from(productsMap.values());

    // Tính avg rating từng product dựa trên feedback
    products.forEach(p => {
      if (p.Feedback.length > 0) {
        const total = p.Feedback.reduce((sum, fb) => sum + (fb.CRating || 0), 0);
        p.AvgRating = parseFloat((total / p.Feedback.length).toFixed(2));
      } else {
        p.AvgRating = null;
      }
    });

    products.forEach(p => {
      if (!p.Status || p.Status === 'N/A') {
        p.Status = 'Unknown';  // Mặc định trạng thái nếu chưa có
      }
    });

    res.json(products);

  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).send('Error fetching data from database: ' + err.message);
  }
});

// API analyze sentiment từng feedback chưa có sentiment (nếu muốn dùng riêng)
app.post('/analyze-sentiment', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT FeedbackID, FeedbackText
      FROM CustomerFeedback
      WHERE Sentiment IS NULL
    `);

    const feedbacks = result.recordset;

    for (const fb of feedbacks) {
      const analysisResult = sentiment.analyze(fb.FeedbackText);
      
      let analysis;
      if (typeof analysisResult === 'object' && 'score' in analysisResult) {
        if (analysisResult.score > 0) analysis = 'Positive';
        else if (analysisResult.score < 0) analysis = 'Negative';
        else analysis = 'Neutral';
      } else if (typeof analysisResult === 'string') {
        analysis = analysisResult;
      } else {
        analysis = 'Neutral';
      }
      
      await pool.request()
        .input('Sentiment', sql.VarChar, analysis)
        .input('FeedbackID', sql.Int, fb.FeedbackID)
        .query(`UPDATE CustomerFeedback SET Sentiment = @Sentiment WHERE FeedbackID = @FeedbackID`);
    }

    res.json({ message: `${feedbacks.length} feedbacks analyzed.` });

  } catch (err) {
    console.error('Sentiment analysis error:', err);
    res.status(500).send('Error analyzing sentiment: ' + err.message);
  }
});

// API cập nhật trạng thái sản phẩm dựa trên sentiment feedback (nếu muốn dùng riêng)
app.post('/update-product-status', async (req, res) => {
  try {
    const pool = await poolPromise;

    const feedbacks = await pool.request().query(`
      SELECT ProductID, Sentiment
      FROM CustomerFeedback
      WHERE Sentiment IN ('Positive', 'Negative', 'Neutral')
    `);

    const productMap = new Map();

    feedbacks.recordset.forEach(fb => {
      if (!productMap.has(fb.ProductID)) {
        productMap.set(fb.ProductID, { Positive: 0, Negative: 0, Neutral: 0 });
      }
      const counts = productMap.get(fb.ProductID);
      if (fb.Sentiment === 'Positive') counts.Positive++;
      else if (fb.Sentiment === 'Negative') counts.Negative++;
      else counts.Neutral++;
    });

    for (const [productId, counts] of productMap) {
      const total = counts.Positive + counts.Negative + counts.Neutral;

      let status = 'Unknown';
      if (counts.Positive / total > 0.4) status = 'Positive';
      else if (counts.Negative / total > 0.4) status = 'Negative';
      else status = 'Neutral';

      await pool.request()
        .input('Status', sql.VarChar, status)
        .input('ProductID', sql.Int, productId)
        .query(`UPDATE Products SET Status = @Status WHERE ProductID = @ProductID`);
    }

    res.json({ message: `${productMap.size} products updated.` });

  } catch (err) {
    console.error('Error updating product status:', err);
    res.status(500).send('Error updating product status: ' + err.message);
  }
});


// API insert feedback mới + phân tích sentiment + cập nhật product status luôn
app.post('/add-feedback', async (req, res) => {
  const { ProductID, CustomerName, FeedbackText, CRating } = req.body;
  
  if (!ProductID || !CustomerName || !FeedbackText || CRating == null) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const pool = await poolPromise;

    // 1. Insert feedback mới (chưa có sentiment)
    const insertResult = await pool.request()
      .input('ProductID', sql.Int, ProductID)
      .input('CustomerName', sql.NVarChar(100), CustomerName)
      .input('FeedbackText', sql.NVarChar(sql.MAX), FeedbackText)
      .input('CRating', sql.Decimal(3,2), CRating)
      .query(`
        INSERT INTO CustomerFeedback (ProductID, CustomerName, FeedbackText, CRating)
        VALUES (@ProductID, @CustomerName, @FeedbackText, @CRating);
        SELECT SCOPE_IDENTITY() AS FeedbackID;
      `);

    const feedbackID = insertResult.recordset[0].FeedbackID;

    // 2. Phân tích sentiment cho feedback mới
    const analysisResult = sentiment.analyze(FeedbackText);
    let sentimentLabel = 'Neutral';
    if (typeof analysisResult === 'object' && 'score' in analysisResult) {
      if (analysisResult.score > 0) sentimentLabel = 'Positive';
      else if (analysisResult.score < 0) sentimentLabel = 'Negative';
    }

    // 3. Cập nhật sentiment cho feedback mới
    await pool.request()
      .input('Sentiment', sql.VarChar(20), sentimentLabel)
      .input('FeedbackID', sql.Int, feedbackID)
      .query(`UPDATE CustomerFeedback SET Sentiment = @Sentiment WHERE FeedbackID = @FeedbackID`);

    // 4. Lấy tất cả feedback của sản phẩm để tính status mới
    const feedbacks = await pool.request()
      .input('ProductID', sql.Int, ProductID)
      .query(`SELECT Sentiment FROM CustomerFeedback WHERE ProductID = @ProductID AND Sentiment IN ('Positive','Negative','Neutral')`);

    // 5. Tính status mới dựa trên feedback sentiment
    const counts = { Positive: 0, Negative: 0, Neutral: 0 };
    feedbacks.recordset.forEach(fb => {
      if (fb.Sentiment === 'Positive') counts.Positive++;
      else if (fb.Sentiment === 'Negative') counts.Negative++;
      else counts.Neutral++;
    });

    const total = counts.Positive + counts.Negative + counts.Neutral;
    let productStatus = 'Neutral';
    if (total > 0) {
      if (counts.Positive / total > 0.4) productStatus = 'Positive';
      else if (counts.Negative / total > 0.4) productStatus = 'Negative';
    } else {
      productStatus = 'Unknown';
    }

    // 6. Cập nhật status sản phẩm
    await pool.request()
      .input('Status', sql.VarChar(20), productStatus)
      .input('ProductID', sql.Int, ProductID)
      .query(`UPDATE Products SET Status = @Status WHERE ProductID = @ProductID`);

    res.json({ message: 'Feedback added and status updated.', FeedbackID: feedbackID, Sentiment: sentimentLabel, ProductStatus: productStatus });
  } catch (err) {
    console.error('Error in add-feedback:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start Server phải nằm cuối cùng
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Document = require('../models/Document');
const Transaction = require('../models/Transaction');
const Anomaly = require('../models/Anomaly');
const { auth } = require('../middleware/auth');
const { processDocument, detectAnomalies } = require('../services/aiService');
const router = express.Router();

const cloudinary = require('../config/cloudinary');

const UPLOAD_FOLDER = 'financial_docs';
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

// Configure multer for memory storage
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only images and documents are allowed'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter
});

// Helper function to upload buffer to Cloudinary
const uploadToCloudinary = (buffer, folder = 'financial_docs') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'auto'
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
};

// Signed upload config for direct browser-to-Cloudinary uploads (bypasses Vercel 4.5MB limit)
router.get('/upload-signature', auth, (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = { timestamp, folder: UPLOAD_FOLDER };
    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      success: true,
      data: {
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        timestamp,
        signature,
        folder: UPLOAD_FOLDER
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Register a document after direct Cloudinary upload
router.post('/register', auth, async (req, res) => {
  try {
    const { publicId, secureUrl, bytes, originalName, mimeType } = req.body;

    if (!publicId || !secureUrl || !originalName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required upload metadata'
      });
    }

    if (bytes && bytes > MAX_FILE_SIZE) {
      return res.status(400).json({
        success: false,
        message: 'File is too large. Max size is 15MB'
      });
    }

    const document = await createDocumentRecord({
      userId: req.userId,
      originalName,
      publicId,
      secureUrl,
      bytes: bytes || 0,
      mimeType: mimeType || 'application/octet-stream'
    });

    res.status(201).json({
      success: true,
      data: document,
      message: 'Document uploaded successfully. AI processing started.'
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get all documents for current user
router.get('/', auth, async (req, res) => {
  try {
    const { search, status } = req.query;
    const filter = { user: req.userId };

    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { originalName: { $regex: search, $options: 'i' } },
        { merchant: { $regex: search, $options: 'i' } }
      ];
    }

    const documents = await Document.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: documents
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get single document
router.get('/:id', auth, async (req, res) => {
  try {
    const document = await Document.findOne({
      _id: req.params.id,
      user: req.userId
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    res.json({
      success: true,
      data: document
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Download document file
router.get('/:id/download', auth, async (req, res) => {
  try {
    const document = await Document.findOne({
      _id: req.params.id,
      user: req.userId
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    // Redirect to Cloudinary URL for download (force download by adding flag if needed, or let browser handle)
    // Cloudinary supports fl_attachment in URL transformation to force download
    // Ensure we handle both raw files (pdf) and images
    let downloadUrl = document.filePath;

    // Simple redirect to the file URL
    res.redirect(downloadUrl);

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// View document file
router.get('/:id/view', auth, async (req, res) => {
  try {
    const document = await Document.findOne({
      _id: req.params.id,
      user: req.userId
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    // Redirect to Cloudinary URL
    res.redirect(document.filePath);

  } catch (error) {
    console.error('View error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Upload document with AI processing
router.post('/', auth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File is too large. Max size is 15MB'
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message
      });
    }
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const cloudinaryResult = await uploadToCloudinary(req.file.buffer);

    const document = await createDocumentRecord({
      userId: req.userId,
      originalName: req.file.originalname,
      publicId: cloudinaryResult.public_id,
      secureUrl: cloudinaryResult.secure_url,
      bytes: cloudinaryResult.bytes,
      mimeType: req.file.mimetype
    });

    res.status(201).json({
      success: true,
      data: document,
      message: 'Document uploaded successfully. AI processing started.'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

async function createDocumentRecord({ userId, originalName, publicId, secureUrl, bytes, mimeType }) {
  const document = new Document({
    user: userId,
    originalName,
    fileName: publicId,
    filePath: secureUrl,
    fileSize: bytes,
    mimeType,
    status: 'processing'
  });

  await document.save();

  await processDocumentWithAI(document, userId).catch((err) => {
    console.error('Background AI processing error:', err);
  });

  return document;
}

// Background AI processing function
async function processDocumentWithAI(document, userId) {
  try {
    // Determine AI provider (use Gemini by default, fallback to OpenAI)
    const aiProvider = process.env.GEMINI_API_KEY ? 'gemini' : 'openai';

    // Process document with AI
    const extractedData = await processDocument(
      document.filePath,
      document.mimeType,
      aiProvider
    );

    // Update document with extracted data
    document.merchant = extractedData.merchant;
    document.category = extractedData.category;
    document.amount = extractedData.amount;
    document.currency = extractedData.currency;
    document.transactionDate = extractedData.transactionDate;
    document.extractedData = {
      text: extractedData.extractedText,
      aiProvider: extractedData.aiProvider,
      description: extractedData.description
    };
    document.status = 'processed';
    await document.save();

    // Create transaction from extracted data
    const transaction = new Transaction({
      user: userId,
      merchant: extractedData.merchant,
      amount: extractedData.amount,
      currency: extractedData.currency,
      category: extractedData.category,
      type: extractedData.type || 'expense', // Use detected type, default to expense
      date: extractedData.transactionDate,
      description: extractedData.description,
      document: document._id,
      status: 'completed'
    });
    await transaction.save();

    // Get user's transaction history for anomaly detection
    const userTransactions = await Transaction.find({ user: userId }).limit(100);

    // Detect anomalies
    const anomalyResult = await detectAnomalies(transaction, userTransactions);

    if (anomalyResult && anomalyResult.isAnomaly) {
      // Create anomaly record
      const anomaly = new Anomaly({
        user: userId,
        transaction: transaction._id,
        type: 'unusual_amount',
        severity: anomalyResult.riskScore > 0.7 ? 'high' : anomalyResult.riskScore > 0.4 ? 'medium' : 'low',
        description: anomalyResult.reason,
        status: 'new',
        metadata: {
          riskScore: anomalyResult.riskScore,
          recommendation: anomalyResult.recommendation,
          aiProvider
        }
      });

      await anomaly.save();
    }

    console.log(`Document ${document._id} processed successfully with ${aiProvider}`);
  } catch (error) {
    console.error('AI processing failed:', error);
    document.status = 'failed';
    document.extractedData = { error: error.message };
    await document.save();
  }
}

// Delete document
router.delete('/:id', auth, async (req, res) => {
  try {
    const document = await Document.findOne({
      _id: req.params.id,
      user: req.userId
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    // Delete from Cloudinary using the public ID (stored in fileName)
    if (document.fileName) {
      // Determine resource_type based on mimeType (raw for pdf/doc, image for others)
      const resourceType = document.mimeType === 'application/pdf' || document.mimeType.includes('application') ? 'raw' : 'image';

      try {
        await cloudinary.uploader.destroy(document.fileName, { resource_type: resourceType });
      } catch (cloudinaryError) {
        console.error('Cloudinary delete error:', cloudinaryError);
        // Continue to delete from DB even if cloud delete fails
      }
    }

    await document.deleteOne();

    res.json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;

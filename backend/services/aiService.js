const { ChatGroq } = require("@langchain/groq");
const { PromptTemplate } = require("@langchain/core/prompts");
const { z } = require("zod");
const fs = require('fs');
const pdf = require('pdf-parse');
const axios = require('axios');
const Tesseract = require('tesseract.js');

// Configure Groq instances
const getGroqModel = (modelName = "llama-3.3-70b-versatile") => {
  return new ChatGroq({
    model: modelName,
    temperature: 0.3,
    maxRetries: 3,
    apiKey: process.env.GROQ_API_KEY,
  });
};

/**
 * Extract transaction data from text using LangChain & Groq
 */
async function extractTransactionData(text) {
  try {
    const model = getGroqModel();

    const transactionSchema = z.object({
      merchant: z.string().default("Unknown Merchant").describe("The business or merchant name. Use 'Unknown Merchant' if unable to determine."),
      amount: z.number().default(0).describe("The transaction amount as a number (e.g., 125.50). Must be a number."),
      currency: z.string().default("INR").describe("The currency code (e.g., INR, USD, EUR, default to INR if not found)"),
      type: z.enum(["income", "expense"]).default("expense").describe("The transaction type. Use 'income' for: salary, payment received, refund, deposit, credit, revenue, earnings, bonus, reimbursement, cashback. Use 'expense' for: purchase, bill, payment made, debit, shopping, spending, withdrawal."),
      category: z.string().default("Other").describe("The transaction category. Must be one of: Groceries, Shopping, Food, Gas, Utilities, Transport, Entertainment, Healthcare, Salary, Other. If it does not fit perfectly, use 'Other'."),
      date: z.string().describe("The transaction date in ISO format YYYY-MM-DD (e.g., 2024-12-25)"),
      description: z.string().default("").describe("A brief description of the transaction")
    });

    const structuredLlm = model.withStructuredOutput(transactionSchema);

    const promptTemplate = PromptTemplate.fromTemplate(
      `You are a financial document analyzer. Extract transaction information from the following text.
      
      Text: "{text}"
      `
    );

    const prompt = await promptTemplate.invoke({ text });
    const response = await structuredLlm.invoke(prompt);

    return {
      merchant: response.merchant || 'Unknown Merchant',
      amount: parseFloat(response.amount) || 0,
      currency: response.currency || 'INR',
      type: (response.type && (response.type === 'income' || response.type === 'expense')) ? response.type : 'expense',
      category: ["Groceries", "Shopping", "Food", "Gas", "Utilities", "Transport", "Entertainment", "Healthcare", "Salary", "Other"].includes(response.category) ? response.category : 'Other',
      transactionDate: response.date ? new Date(response.date) : new Date(),
      description: response.description || ''
    };
  } catch (error) {
    console.error("Groq extraction error:", error);
    throw error;
  }
}

const { GoogleGenAI } = require('@google/genai');

/**
 * Extract text from image using Gemini 
 */
async function extractTextFromImage(imagePath) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.warn('GEMINI_API_KEY is not set. Falling back to basic parsing or failing.');
      throw new Error('Please set GEMINI_API_KEY in your .env file to use image upload.');
    }

    let buffer;
    let mimeType = 'image/jpeg';
    
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      const response = await axios.get(imagePath, { responseType: 'arraybuffer' });
      buffer = Buffer.from(response.data);
      mimeType = response.headers['content-type'] || 'image/jpeg';
    } else {
      buffer = fs.readFileSync(imagePath);
      if (imagePath.toLowerCase().endsWith('.png')) mimeType = 'image/png';
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        'Extract all the readable text from this receipt/document exactly as it appears. Do not add any extra commentary.',
        { inlineData: { data: buffer.toString('base64'), mimeType } }
      ]
    });

    return response.text;
  } catch (error) {
    console.error('Image extraction error (Gemini):', error.message);
    throw new Error('Failed to extract text from image');
  }
}

/**
 * Extract text from PDF using pdf-parse
 */
async function extractTextFromPDF(pdfPath) {
  try {
    let dataBuffer;
    if (pdfPath.startsWith('http://') || pdfPath.startsWith('https://')) {
      const response = await axios.get(pdfPath, { responseType: 'arraybuffer' });
      dataBuffer = Buffer.from(response.data);
    } else {
      dataBuffer = fs.readFileSync(pdfPath);
    }
    const data = await pdf(dataBuffer);
    if (!data || !data.text) throw new Error('No text extracted from PDF');
    return data.text;
  } catch (error) {
    console.error('PDF text extraction error:', error.message);
    return '';
  }
}

/**
 * Process document and extract transaction data
 */
async function processDocument(filePath, mimeType, useAI = 'groq') {
  try {
    let extractedText = '';

    if (mimeType.includes('pdf')) {
      extractedText = await extractTextFromPDF(filePath);
    } else if (mimeType.includes('image')) {
      extractedText = await extractTextFromImage(filePath);
    } else {
      throw new Error('Unsupported file type');
    }

    extractedText = extractedText.trim();

    if (!extractedText || extractedText.length < 10) {
      throw new Error('No readable text found in document');
    }

    const transactionData = await extractTransactionData(extractedText);

    return {
      ...transactionData,
      extractedText,
      aiProvider: 'groq'
    };
  } catch (error) {
    console.error('Document processing error:', error);
    throw error;
  }
}

/**
 * Detect anomalies in transaction using Groq
 */


async function detectAnomalies(transaction, userTransactionHistory) {
  try {
    const model = getGroqModel();

    const anomalySchema = z.object({
      isAnomaly: z.boolean().describe("true if the transaction is suspicious based on history"),
      riskScore: z.number().min(0).max(1).describe("Risk score from 0 to 1, where 1 is highest risk"),
      reason: z.string().describe("Brief explanation of why it was flagged or why it is normal"),
      recommendation: z.string().describe("What the user should do (e.g., verify, ignore)")
    });

    const structuredLlm = model.withStructuredOutput(anomalySchema);

    const avgAmount = userTransactionHistory.length > 0
      ? userTransactionHistory.reduce((sum, t) => sum + t.amount, 0) / userTransactionHistory.length
      : 0;

    const categoryTransactions = userTransactionHistory.filter(
      t => t.category === transaction.category
    );
    const avgCategoryAmount = categoryTransactions.length > 0
      ? categoryTransactions.reduce((sum, t) => sum + t.amount, 0) / categoryTransactions.length
      : 0;

    const promptTemplate = PromptTemplate.fromTemplate(
      `Analyze this transaction for anomalies based on user's spending pattern.

Current Transaction:
- Merchant: {merchant}
- Amount: {amount}
- Category: {category}
- Date: {date}

User's Spending Pattern:
- Average transaction amount: {avgAmount}
- Average amount in {category}: {avgCategoryAmount}
- Total transactions: {totalTransactions}`
    );

    const prompt = await promptTemplate.invoke({
      merchant: transaction.merchant,
      amount: transaction.amount,
      category: transaction.category,
      date: transaction.date,
      avgAmount: avgAmount.toFixed(2),
      avgCategoryAmount: avgCategoryAmount.toFixed(2),
      totalTransactions: userTransactionHistory.length
    });

    const response = await structuredLlm.invoke(prompt);
    return response;
  } catch (error) {
    console.error('Anomaly detection error:', error.message);
    return null;
  }
}

/**
 * Generate financial insights using Groq
 */
async function generateFinancialInsights(transactions) {
  try {
    const model = getGroqModel();

    const insightsSchema = z.object({
      insights: z.array(z.string()).describe("3-5 actionable insights and recommendations to improve financial health")
    });

    const structuredLlm = model.withStructuredOutput(insightsSchema);

    const totalIncome = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
    const totalExpenses = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);

    const categoryBreakdown = {};
    transactions.forEach(t => {
      if (t.type === 'expense') {
        categoryBreakdown[t.category] = (categoryBreakdown[t.category] || 0) + t.amount;
      }
    });

    const topCategories = Object.entries(categoryBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, amt]) => `${cat}: ₹${amt.toFixed(2)}`)
      .join(', ');

    const promptTemplate = PromptTemplate.fromTemplate(
      `As a financial advisor, provide insights and recommendations based on this spending data.

Summary:
- Total Income: ₹{totalIncome}
- Total Expenses: ₹{totalExpenses}
- Net: ₹{net}
- Top spending categories: {topCategories}
- Number of transactions: {numTransactions}`
    );

    const prompt = await promptTemplate.invoke({
      totalIncome: totalIncome.toFixed(2),
      totalExpenses: totalExpenses.toFixed(2),
      net: (totalIncome - totalExpenses).toFixed(2),
      topCategories: topCategories,
      numTransactions: transactions.length
    });

    const response = await structuredLlm.invoke(prompt);
    return response.insights;
  } catch (error) {
    console.error('Insights generation error:', error.message);
    return [];
  }
}

module.exports = {
  processDocument,
  detectAnomalies,
  generateFinancialInsights,
  extractTransactionData
};

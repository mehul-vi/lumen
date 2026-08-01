import { useCallback, useEffect, useState, useRef } from 'react';
import { Search, FileText, Download, Eye, Trash2, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import DocumentUpload from './DocumentUpload';
import apiClient, { API_BASE_URL } from '../lib/apiClient';
import useDebouncedValue from '../hooks/useDebouncedValue';
import { formatCurrency, formatDate } from '../utils/formatters';
import { useRefreshSubscription } from '../hooks/useRefresh';

export default function Documents() {
  const [documents, setDocuments] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const debouncedSearch = useDebouncedValue(searchTerm);
  const pollingRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;

    pollingRef.current = setInterval(async () => {
      try {
        const response = await apiClient.get('/documents');
        const docs = response.data.data || [];
        setDocuments(docs);

        const processingDocs = docs.filter((doc) => doc.status === 'processing');
        if (processingDocs.length === 0) {
          stopPolling();
        }
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 3000);
  }, [stopPolling]);

  const fetchDocuments = useCallback(
    async (searchValue = '') => {
      setLoading(true);
      try {
        const response = await apiClient.get('/documents', {
          params: searchValue ? { search: searchValue } : undefined
        });
        setDocuments(response.data.data || []);

        const processingDocs = response.data.data?.filter((doc) => doc.status === 'processing');
        if (processingDocs?.length > 0) {
          startPolling();
        } else {
          stopPolling();
        }
      } catch (error) {
        toast.error(error.message);
      } finally {
        setLoading(false);
      }
    },
    [startPolling, stopPolling]
  );
  
  // Subscribe to refresh events
  useRefreshSubscription(() => {
    fetchDocuments(debouncedSearch);
  });

  useEffect(() => {
    fetchDocuments(debouncedSearch);
    
    // Cleanup polling on unmount
    return () => {
      stopPolling();
    };
  }, [debouncedSearch, fetchDocuments, stopPolling]);

  const handleView = (id) => {
    try {
      // Get token from localStorage using the correct key
      const token = localStorage.getItem('lumen_token');
      if (!token) {
        toast.error('Authentication token not found');
        return;
      }
      
      // Create URL with token as query parameter
      const url = `${API_BASE_URL}/documents/${id}/view?token=${encodeURIComponent(token)}`;
      
      // Open in new tab
      window.open(url, '_blank');
    } catch (error) {
      toast.error('Failed to view document: ' + error.message);
    }
  };

  const handleDownload = (id) => {
    try {
      // Get token from localStorage using the correct key
      const token = localStorage.getItem('lumen_token');
      if (!token) {
        toast.error('Authentication token not found');
        return;
      }
      
      // Create URL with token as query parameter
      const url = `${API_BASE_URL}/documents/${id}/download?token=${encodeURIComponent(token)}`;
      
      // Create download link
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      toast.error('Failed to download document: ' + error.message);
    }
  };

  const handleDelete = async (id) => {
    setDeletingId(id);
    try {
      await apiClient.delete(`/documents/${id}`);
      setDocuments((prev) => prev.filter((doc) => doc._id !== id));
      toast.success('Document deleted successfully');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleUploadComplete = (document) => {
    if (document) {
      setDocuments((prev) => [document, ...prev]);
      if (document.status === 'processing') {
        startPolling();
      }
    } else {
      fetchDocuments(debouncedSearch);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Documents</h1>
        <p className="text-gray-600 mt-1">Upload and manage your financial documents</p>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Upload New Documents</h2>
        <DocumentUpload onUploadComplete={handleUploadComplete} />
      </div>

      <div className="card">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search documents by name or merchant..."
            className="input-field pl-10"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Fetching documents...
          </div>
        ) : documents.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No documents found{debouncedSearch ? ' for this search.' : '.'}
          </div>
        ) : (
          <div className="space-y-4">
            {documents.map((doc) => (
              <div
                key={doc._id}
                className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center space-x-4 flex-1">
                  <div className="bg-primary-100 p-3 rounded-lg">
                    <FileText className="h-6 w-6 text-primary-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-gray-900 truncate">{doc.originalName}</h3>
                    <div className="flex flex-wrap items-center gap-x-2 mt-1 text-sm text-gray-500">
                      {doc.merchant && <span>{doc.merchant}</span>}
                      {doc.category && <span>• {doc.category}</span>}
                      {doc.amount && <span>• {formatCurrency(doc.amount, doc.currency)}</span>}
                      {doc.transactionDate && <span>• {formatDate(doc.transactionDate)}</span>}
                    </div>
                  </div>
                  <span
                    className={`px-3 py-1 text-xs font-medium rounded-full ${
                      doc.status === 'processed'
                        ? 'bg-green-100 text-green-800'
                        : doc.status === 'failed'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {doc.status}
                  </span>
                </div>
                <div className="flex items-center space-x-2 ml-4">
                  <button
                    onClick={() => handleView(doc._id)}
                    className="p-2 hover:bg-gray-200 rounded-lg"
                    title="View document"
                  >
                    <Eye className="h-5 w-5 text-gray-600" />
                  </button>
                  <button
                    onClick={() => handleDownload(doc._id)}
                    className="p-2 hover:bg-gray-200 rounded-lg"
                    title="Download document"
                  >
                    <Download className="h-5 w-5 text-gray-600" />
                  </button>
                  <button
                    onClick={() => handleDelete(doc._id)}
                    disabled={deletingId === doc._id}
                    className="p-2 hover:bg-gray-200 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {deletingId === doc._id ? (
                      <Loader2 className="h-5 w-5 text-red-500 animate-spin" />
                    ) : (
                      <Trash2 className="h-5 w-5 text-red-600" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


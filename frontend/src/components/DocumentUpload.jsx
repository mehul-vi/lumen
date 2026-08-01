import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, X, CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../lib/apiClient';
import { useRefresh } from '../hooks/useRefresh';

const buildId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export default function DocumentUpload({ onUploadComplete }) {
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const { triggerRefresh } = useRefresh();

  const updateFile = useCallback((id, payload) => {
    setUploadedFiles((prev) => prev.map((file) => (file.id === id ? { ...file, ...payload } : file)));
  }, []);

  const processFiles = useCallback(
    async (files) => {
      setProcessing(true);
      for (const fileObj of files) {
        updateFile(fileObj.id, { status: 'uploading' });
        try {
          const formData = new FormData();
          formData.append('file', fileObj.file);
          const response = await apiClient.post('/documents', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
          updateFile(fileObj.id, { status: 'processed', document: response.data.data });
          toast.success(`${fileObj.name} uploaded successfully`);
          onUploadComplete?.(response.data.data);
          // Trigger refresh for other components
          triggerRefresh();
        } catch (error) {
          updateFile(fileObj.id, { status: 'failed', error: error.message });
          toast.error(`${fileObj.name}: ${error.message}`);
        }
      }
      setProcessing(false);
    },
    [onUploadComplete, updateFile]
  );

  const onDrop = useCallback(
    (acceptedFiles, fileRejections) => {
      if (fileRejections.length > 0) {
        fileRejections.forEach((rejection) => {
          if (rejection.errors[0]?.code === 'file-too-large') {
            toast.error(`File is too large. Max size is 4.5MB`);
          } else {
            toast.error(rejection.errors[0]?.message || 'File rejected');
          }
        });
      }

      if (!acceptedFiles.length) return;
      const newFiles = acceptedFiles.map((file) => ({
        id: buildId(),
        file,
        name: file.name,
        size: file.size,
        type: file.type,
        status: 'pending'
      }));

      setUploadedFiles((prev) => [...newFiles, ...prev]);
      processFiles(newFiles);
    },
    [processFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg'],
      'application/pdf': ['.pdf']
    },
    maxSize: 4.5 * 1024 * 1024
  });

  const removeFile = (id) => {
    setUploadedFiles((prev) => prev.filter((file) => file.id !== id));
  };

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          isDragActive
            ? 'border-primary-500 bg-primary-50'
            : 'border-gray-300 hover:border-primary-400 hover:bg-gray-50'
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        {isDragActive ? (
          <p className="text-primary-600 font-medium">Drop files here...</p>
        ) : (
          <div>
            <p className="text-gray-600 mb-2">
              Drag & drop receipts, invoices, or transaction records here
            </p>
            <p className="text-sm text-gray-500">or click to browse (PDF, PNG, JPG up to 4.5MB)</p>
          </div>
        )}
      </div>

      {uploadedFiles.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-gray-900">Recent uploads</h3>
          {uploadedFiles.map((fileObj) => (
            <div key={fileObj.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center space-x-3 flex-1">
                <FileText className="h-5 w-5 text-gray-400" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{fileObj.name}</p>
                  <p className="text-xs text-gray-500">{(fileObj.size / 1024).toFixed(2)} KB</p>
                </div>
                {fileObj.status === 'processed' && <CheckCircle className="h-5 w-5 text-green-500" />}
                {fileObj.status === 'uploading' && <Loader2 className="h-5 w-5 text-primary-500 animate-spin" />}
                {fileObj.status === 'failed' && <AlertCircle className="h-5 w-5 text-red-500" />}
              </div>
              <button onClick={() => removeFile(fileObj.id)} className="p-1 hover:bg-gray-200 rounded">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>
          ))}
        </div>
      )}

      {processing && (
        <div className="text-center py-4">
          <div className="inline-flex items-center space-x-2 text-primary-600">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Processing with AI services...</span>
          </div>
        </div>
      )}
    </div>
  );
}


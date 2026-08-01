import apiClient from './apiClient';

export async function uploadDocumentToCloudinary(file) {
  const { data: signatureResponse } = await apiClient.get('/documents/upload-signature');
  const { cloudName, apiKey, timestamp, signature, folder } = signatureResponse.data;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('api_key', apiKey);
  formData.append('timestamp', String(timestamp));
  formData.append('signature', signature);
  formData.append('folder', folder);

  const uploadResponse = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
    method: 'POST',
    body: formData
  });

  const uploadResult = await uploadResponse.json();

  if (!uploadResponse.ok) {
    throw new Error(uploadResult.error?.message || 'Cloudinary upload failed');
  }

  const { data: registerResponse } = await apiClient.post('/documents/register', {
    publicId: uploadResult.public_id,
    secureUrl: uploadResult.secure_url,
    bytes: uploadResult.bytes,
    originalName: file.name || 'document',
    mimeType:
      file.type ||
      (uploadResult.format === 'pdf' ? 'application/pdf' : `image/${uploadResult.format}`)
  });

  return registerResponse.data;
}

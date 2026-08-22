const { v2: cloudinary } = require("cloudinary");

const requiredKeys = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];

function configureCloudinary() {
  const missing = requiredKeys.filter(key => !process.env[key]);
  if (missing.length) {
    const err = new Error(`Product images are unavailable. Missing server configuration: ${missing.join(", ")}`);
    err.status = 503;
    throw err;
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  return cloudinary;
}

function uploadProductImage(buffer, itemId) {
  const client = configureCloudinary();
  return new Promise((resolve, reject) => {
    const stream = client.uploader.upload_stream({
      folder: "swag-inventory/products",
      public_id: `item-${itemId}-${Date.now()}`,
      resource_type: "image",
      overwrite: false
    }, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
}

async function deleteProductImage(publicId) {
  if (!publicId) return { result: "not found" };
  return configureCloudinary().uploader.destroy(publicId, { resource_type: "image", invalidate: true });
}

module.exports = { uploadProductImage, deleteProductImage };

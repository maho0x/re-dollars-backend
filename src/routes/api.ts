import { Router } from 'express';
import { MessageController } from '../controllers/messageController.js';
import { UserController } from '../controllers/userController.js';
import { UploadController } from '../controllers/uploadController.js';
import { MiscController } from '../controllers/miscController.js';
import { AdminController } from '../controllers/adminController.js';
import { AuthController } from '../controllers/authController.js';
import { ReadStatusController } from '../controllers/readStatusController.js';
import { getMessageReplies, getReplyCountsBatch } from '../controllers/replyController.js';
import { upload, uploadVideo } from '../middlewares/upload.js';

const router = Router();

// ============ Messages ============
router.get('/messages', MessageController.getMessages);
router.get('/messages/unread-count', MessageController.getUnreadCount);
router.get('/messages/sync', MessageController.syncMessages);
router.get('/messages/status', MessageController.getMessageStatus);
router.get('/messages/by-date', MessageController.getByDate);
router.get('/messages/context/:id', MessageController.getContext);
router.post('/messages/confirm', MessageController.confirmMessage);
router.post('/messages/:id/reactions', MessageController.addReaction);
router.delete('/messages/:id', AuthController.requireAuth, MessageController.deleteMessage);
router.put('/messages/:id', AuthController.requireAuth, MessageController.editMessage);

// ============ Search ============
router.get('/search', MessageController.search);

// ============ Read Status ============
router.get('/messages/read', ReadStatusController.getReadStatus);
router.post('/messages/read', ReadStatusController.updateReadStatus);

// ============ Users ============
router.get('/users/:identifier', UserController.getUser);
router.get('/users/map-uid-to-username/:uid', UserController.mapUidToUsername);
router.post('/users/lookup-by-name', UserController.lookupByName);

// ============ Favorites ============
router.get('/favorites', UserController.getFavorites);
router.post('/favorites', UserController.syncFavorites);
router.post('/favorites/add', UserController.addFavorite);
router.post('/favorites/remove', UserController.removeFavorite);

// ============ Upload ============
router.post('/upload', upload.single('image'), UploadController.uploadImage);
router.post('/upload/video', uploadVideo.single('video'), UploadController.uploadVideo);

// ============ Notifications ============
router.get('/notifications', MiscController.getNotifications);
router.post('/notifications/:id/read', MiscController.readNotification);
router.post('/notifications/read-all', MiscController.readAllNotifications);

// ============ Previews ============
router.get('/preview/:type/:id', MiscController.getBgmPreview);
router.post('/preview/generic-url', MiscController.previewGenericUrl);

// ============ Emojis ============
router.get('/emojis/community', MiscController.getCommunityEmojis);

// ============ Admin ============
router.get('/admin/blocklist', AdminController.getBlocklist);
router.post('/admin/blocklist/add', AdminController.checkAdmin, AdminController.addBlock);
router.post('/admin/blocklist/remove', AdminController.checkAdmin, AdminController.removeBlock);

// ============ Auth ============
router.get('/auth/callback', AuthController.handleCallback);
router.get('/auth/me', AuthController.getMe);
router.post('/auth/token-login', AuthController.tokenLogin);
router.post('/auth/logout', AuthController.logout);

// ============ Debug ============
router.post('/debug/test-notification', MiscController.testNotification);

export default router;

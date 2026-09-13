// Independent entry: no learner store, user login, IndexedDB, router or bank.
import { createApp } from 'vue';
import AdminApp from './AdminApp.vue';
import './admin.css';

createApp(AdminApp).mount('#admin-app');

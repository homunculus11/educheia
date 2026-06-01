// Firebase initialization
// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBr1_qdvpZxZI1jvWvgDe4H7_u0nvjJyj0",
  authDomain: "educheia.firebaseapp.com",
  projectId: "educheia",
  storageBucket: "educheia.firebasestorage.app",
  messagingSenderId: "740416284743",
  appId: "1:740416284743:web:b2022a18e9a26ee66b2962",
  measurementId: "G-2J5GMZQ0G6",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = null;

const auth = getAuth(app);
const db = getFirestore(app);

export { app, analytics, auth, db };

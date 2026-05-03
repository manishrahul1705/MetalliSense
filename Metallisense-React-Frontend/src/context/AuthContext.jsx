import { createContext, useContext, useEffect, useState } from "react";
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail as firebaseSendPasswordResetEmail,
} from "firebase/auth";
import { auth, googleProvider } from "../config/firebase";
import toast from "react-hot-toast";

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mongoUser, setMongoUser] = useState(null);

  // Listen to Firebase auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (firebaseUser) {
        // Fetch MongoDB user data
        try {
          const idToken = await firebaseUser.getIdToken();
          const response = await fetch(
            `${import.meta.env.VITE_API_BASE_URL}/auth/me`,
            {
              headers: {
                Authorization: `Bearer ${idToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          if (response.ok) {
            const data = await response.json();
            setMongoUser(data.data.user);
          }
        } catch (error) {
          console.error("Error fetching user data:", error);
        }
      } else {
        setMongoUser(null);
      }

      setLoading(false);
    });

    return unsubscribe;
  }, []);

  // Signup with email and password
  const signup = async (
    email,
    password,
    displayName,
    role = "Chemical Engineer 1"
  ) => {
    try {
      setLoading(true);

      // Call backend signup endpoint
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL}/auth/signup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            password,
            displayName,
            metadata: { role },
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Signup failed");
      }

      // Sign in with custom token from backend
      const { signInWithCustomToken } = await import("firebase/auth");
      const userCredential = await signInWithCustomToken(
        auth,
        data.data.customToken
      );

      toast.success("Account created successfully!");
      return userCredential.user;
    } catch (error) {
      console.error("Signup error:", error);
      toast.error(error.message || "Failed to create account");
      throw error;
    } finally {
      setLoading(false);
    }
  };

  // Login with email and password
  const login = async (email, password) => {
    try {
      setLoading(true);
      const userCredential = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );
      toast.success("Logged in successfully!");
      return userCredential.user;
    } catch (error) {
      console.error("Login error:", error);

      // Handle specific Firebase errors
      let errorMessage = "Failed to log in";
      if (
        error.code === "auth/user-not-found" ||
        error.code === "auth/wrong-password"
      ) {
        errorMessage = "Invalid email or password";
      } else if (error.code === "auth/too-many-requests") {
        errorMessage = "Too many failed attempts. Please try again later.";
      } else if (error.code === "auth/user-disabled") {
        errorMessage = "This account has been disabled";
      }

      toast.error(errorMessage);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  // Login with Google
  const loginWithGoogle = async () => {
    try {
      setLoading(true);
      const result = await signInWithPopup(auth, googleProvider);
      toast.success("Logged in with Google successfully!");
      return result.user;
    } catch (error) {
      console.error("Google login error:", error);

      let errorMessage = "Failed to log in with Google";
      if (error.code === "auth/popup-closed-by-user") {
        errorMessage = "Login popup was closed";
      } else if (error.code === "auth/cancelled-popup-request") {
        errorMessage = "Login cancelled";
      }

      toast.error(errorMessage);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  // Logout
  const logout = async () => {
    try {
      await firebaseSignOut(auth);
      setMongoUser(null);
      toast.success("Logged out successfully");
    } catch (error) {
      console.error("Logout error:", error);
      toast.error("Failed to log out");
      throw error;
    }
  };

  // Send email verification
  const sendVerificationEmail = async () => {
    try {
      if (user) {
        await sendEmailVerification(user);
        toast.success("Verification email sent!");
      }
    } catch (error) {
      console.error("Email verification error:", error);
      toast.error("Failed to send verification email");
      throw error;
    }
  };

  // Send password reset email
  const sendPasswordReset = async (email) => {
    try {
      await firebaseSendPasswordResetEmail(auth, email);
      toast.success("Password reset email sent!");
    } catch (error) {
      console.error("Password reset error:", error);

      let errorMessage = "Failed to send password reset email";
      if (error.code === "auth/user-not-found") {
        errorMessage = "No account found with this email";
      }

      toast.error(errorMessage);
      throw error;
    }
  };

  // Update user profile
  const updateUserProfile = async (updates) => {
    try {
      if (!user) throw new Error("No user logged in");

      const idToken = await user.getIdToken();
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL}/auth/profile`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updates),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to update profile");
      }

      toast.success("Profile updated successfully!");

      // Refresh user data
      await user.reload();
      setUser({ ...auth.currentUser });

      return data.data.user;
    } catch (error) {
      console.error("Profile update error:", error);
      toast.error(error.message || "Failed to update profile");
      throw error;
    }
  };

  // Get current ID token
  const getIdToken = async () => {
    if (!user) return null;
    return await user.getIdToken();
  };

  const value = {
    user,
    mongoUser,
    loading,
    signup,
    login,
    loginWithGoogle,
    logout,
    sendVerificationEmail,
    sendPasswordReset,
    updateUserProfile,
    getIdToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

import axios from "axios";
import jwt from "jsonwebtoken";

export const people = axios.create({
  baseURL: "https://people-api.goodparty.org",
});

people.interceptors.request.use((config) => {
  if (!process.env.PEOPLE_API_SECRET) {
    throw new Error("PEOPLE_API_SECRET is not set");
  }
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { iss: "gp-api", iat: now, exp: now + 300 },
    process.env.PEOPLE_API_SECRET
  );
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

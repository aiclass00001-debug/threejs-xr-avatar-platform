import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("XR Avatar Studio root element is missing.");

createRoot(root).render(<Home />);

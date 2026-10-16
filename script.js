// Small, accessible mobile navigation. No framework required.
const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#site-nav");

if (menuButton && navigation) {
  menuButton.addEventListener("click", () => {
    const isOpen = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!isOpen));
    menuButton.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
    navigation.classList.toggle("is-open", !isOpen);
  });

  navigation.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menuButton.setAttribute("aria-expanded", "false");
      menuButton.setAttribute("aria-label", "Open navigation");
      navigation.classList.remove("is-open");
    });
  });
}

// Prevent placeholder project links from pretending to work before URLs are added.
document.querySelectorAll("[data-placeholder-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (link.getAttribute("href") === "#") {
      event.preventDefault();
      alert("Add your real project URL in index.html before publishing this link.");
    }
  });
});

const uploadDatabaseName = "ibitoru-archive-uploads";
const uploadObjectUrls = new WeakMap();
const uploadInputs = [...document.querySelectorAll("[data-upload-image], [data-upload-profile], [data-upload-document]")];

function getUploadKey(input) {
  return input.getAttribute("aria-label").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function openUploadDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(uploadDatabaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("uploads");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function setUploadStatus(input, fileName, saved) {
  if (!input.hasAttribute("data-upload-status")) return;

  const label = input.closest(".upload-control");
  let status = label.querySelector(".upload-status");
  if (!status) {
    status = document.createElement("span");
    status.className = "upload-status";
    label.append(status);
  }
  status.textContent = `${saved ? "Saved" : "Temporary"}: ${fileName}`;
  status.title = fileName;
}

function applyUploadedFile(input, file) {
  const previousUrl = uploadObjectUrls.get(input);
  if (previousUrl) URL.revokeObjectURL(previousUrl);

  const objectUrl = URL.createObjectURL(file);
  uploadObjectUrls.set(input, objectUrl);

  if (input.matches("[data-upload-profile]")) {
    const image = document.querySelector("[data-profile-image]");
    image.src = objectUrl;
    image.hidden = false;
    document.querySelector("[data-profile-placeholder]").hidden = true;
  } else if (input.matches("[data-upload-image]")) {
    const imageFrame = input.closest(".project-image");
    const image = imageFrame.querySelector("img");
    image.src = objectUrl;
    image.style.display = "block";
    imageFrame.querySelector(".image-placeholder").style.display = "none";
  } else {
    const link = input.closest(".document-actions, .cv-item").querySelector("[data-upload-link]");
    link.href = objectUrl;
    if (link.hasAttribute("data-upload-download")) {
      link.download = file.name;
    }
  }
}

async function saveUpload(input, file) {
  const database = await openUploadDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("uploads", "readwrite");
    transaction.objectStore("uploads").put(file, getUploadKey(input));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function readUpload(database, key) {
  return new Promise((resolve, reject) => {
    const request = database.transaction("uploads", "readonly").objectStore("uploads").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

uploadInputs.forEach((input) => {
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    applyUploadedFile(input, file);
    try {
      await saveUpload(input, file);
      setUploadStatus(input, file.name, true);
    } catch {
      setUploadStatus(input, file.name, false);
    }
  });
});

(async () => {
  let database;
  try {
    database = await openUploadDatabase();
    for (const input of uploadInputs) {
      const file = await readUpload(database, getUploadKey(input));
      if (!file) continue;
      applyUploadedFile(input, file);
      setUploadStatus(input, file.name, true);
    }
  } catch {
    // Keep the page usable when browser storage is unavailable.
  } finally {
    database?.close();
  }
})();

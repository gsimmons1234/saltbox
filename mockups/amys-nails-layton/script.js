(function () {
  "use strict";

  var navToggle = document.getElementById("navToggle");
  var mainNav = document.getElementById("main-nav");

  function closeNav() {
    mainNav.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open menu");
  }

  function openNav() {
    mainNav.classList.add("open");
    navToggle.setAttribute("aria-expanded", "true");
    navToggle.setAttribute("aria-label", "Close menu");
  }

  if (navToggle && mainNav) {
    navToggle.addEventListener("click", function () {
      var isOpen = mainNav.classList.contains("open");
      if (isOpen) {
        closeNav();
      } else {
        openNav();
      }
    });

    mainNav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", closeNav);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeNav();
      }
    });
  }

  var copyBtn = document.getElementById("copyAddressBtn");
  var copyFeedback = document.getElementById("copyFeedback");

  if (copyBtn && copyFeedback) {
    copyBtn.addEventListener("click", function () {
      var address = copyBtn.getAttribute("data-address") || "";

      function showSuccess() {
        copyFeedback.textContent = "Address copied!";
        window.setTimeout(function () {
          copyFeedback.textContent = "";
        }, 2500);
      }

      function showFallbackMessage() {
        copyFeedback.textContent = address;
      }

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(address).then(showSuccess, showFallbackMessage);
      } else {
        var textarea = document.createElement("textarea");
        textarea.value = address;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand("copy");
          showSuccess();
        } catch (err) {
          showFallbackMessage();
        }
        document.body.removeChild(textarea);
      }
    });
  }
})();

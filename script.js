const prefersReduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const revealables = document.querySelectorAll(".reveal");
if (prefersReduced) {
    revealables.forEach((el) => el.classList.add("revealed"));
} else {
    const io = new IntersectionObserver(
        (entries) => {
            for (const e of entries)
                if (e.isIntersecting) {
                    e.target.classList.add("revealed");
                    io.unobserve(e.target);
                }
        },
        { threshold: 0.08, rootMargin: "0px 0px -10% 0px" }
    );
    revealables.forEach((el) => io.observe(el));
}

const navLinks = [...document.querySelectorAll(".site-nav a")];
const sections = navLinks
    .map((a) => document.querySelector(a.getAttribute("href")))
    .filter(Boolean);

const menuBtn = document.getElementById("menuToggle");
const nav = document.getElementById("primaryNav");
if (menuBtn && nav) {
    const closeMenu = () => {
        nav.classList.remove("is-open");
        menuBtn.setAttribute("aria-expanded", "false");
    };
    const openMenu = () => {
        nav.classList.add("is-open");
        menuBtn.setAttribute("aria-expanded", "true");
    };
    const toggleMenu = () => {
        nav.classList.contains("is-open") ? closeMenu() : openMenu();
    };
    menuBtn.addEventListener("click", toggleMenu);
    nav.addEventListener("click", (e) => {
        const t = e.target;
        if (t && t.matches("a")) closeMenu();
    });
    document.addEventListener("click", (e) => {
        if (!nav.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
    });
}

document.addEventListener("DOMContentLoaded", function () {
    const links = document.querySelectorAll("link[data-onload]");
    links.forEach((link) => {
        const onloadCode = link.getAttribute("data-onload");
        link.onload = new Function(onloadCode);
        link.removeAttribute("data-onload");
    });
});

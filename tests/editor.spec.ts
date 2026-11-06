import { test, expect } from "@playwright/test";
test("editor persists a real project and opens export dialog", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:9260");
  await page.getByRole("button", { name: "Çalışma alanına gir" }).click();
  await expect(
    page.getByRole("heading", { name: "Hikâyene yer aç." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Örnek projeyi aç", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /Klip 1 Form/ })).toBeVisible({
    timeout: 120000,
  });
  await page.getByLabel("Klip başlığı", { exact: true }).fill("A tested frame");
  await expect(
    page.getByText("Tüm değişiklikler kaydedildi", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: /Form \/ Motion study/ })
    .first()
    .click();
  await expect(page.getByLabel("Klip başlığı", { exact: true })).toHaveValue(
    "A tested frame",
  );
  await page.getByRole("button", { name: "Dışa aktar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hikâyen dışarı çıksın." }),
  ).toBeVisible();
});

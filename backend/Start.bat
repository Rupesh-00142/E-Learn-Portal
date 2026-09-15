@echo off
REM E-Learn Python backend ko start karne ke liye — bas is file par double-click karo.

echo Installing/checking Flask...
pip install -r requirements.txt

echo.
echo Starting E-Learn backend...
echo Isse band karne ke liye is window mein Ctrl+C dabao.
echo.

python app.py

pause
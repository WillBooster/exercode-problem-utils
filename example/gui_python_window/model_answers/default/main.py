import tkinter as tk

root = tk.Tk()
root.title('Hello Window')
root.geometry('320x180')

label = tk.Label(root, text='Hello Window')
label.pack(expand=True)

root.mainloop()
